import prisma from "../db.server";
import { fanOutServerSide, isBot, sha256Hex } from "./server-side.server";
import { recordDeliveries, recordVisit, getFirstTouch, pruneCap } from "./delivery.server";
import { enqueueFailures } from "./outbox.server";
import { fxHooks } from "./fx.server";
import { googleAdsHook } from "./google-ads.server";
import { redactEvent } from "./redact";

// Shared storefront-event ingestion: bot-filter, buffer for Live events (PII-redacted), first-touch
// attribution, then server-side fan-out to GA4 / Meta / sGTM. Used by both entrypoints:
//   - proxy.$type   → the SEO-engagement theme embed (runs in the main page → can use the app proxy)
//   - pixel.track   → the Web Pixel (strict sandbox blocks same-origin app proxies, so it beacons
//                     cross-origin straight here; the shop is identified from the payload).
export async function ingestEvent(shopDomain, body, clientIp) {
  if (!shopDomain || !body?.event) return;
  const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain } });
  if (!settings) return; // unknown shop → ignore (only shops that installed the app are tracked)

  // Bot filtering: drop known bots/headless agents before anything is recorded or delivered.
  const ua = body.event.userAgent || "";
  if (settings.botFiltering !== false && isBot(ua)) return;

  // Idempotency: a beacon can be replayed (sendBeacon retry, double navigation, network replay). Claim
  // the event id up front (create-wins-the-race, same pattern as the webhooks) so a redelivery doesn't
  // produce a second server-side send — GA4 MP does not dedup non-purchase events, so without this a
  // replayed page_view/add_to_cart is double-counted. Reuses ProcessedWebhook (TTL-purged by the cron).
  //
  // When the pixel supplies no string id, fall back to a content hash of the event's stable identifying
  // fields so a byte-identical replay is still deduped. This needs a timestamp for entropy — without one
  // two legitimate repeat events (e.g. two page_views) would hash the same, and dropping a real event
  // (undercount) is worse than the double-count we're guarding, so we skip the claim in that case.
  const rawId = typeof body.event.id === "string" ? body.event.id.trim() : "";
  const eventId = rawId
    ? rawId
    : body.event.timestamp
      ? `h:${sha256Hex([body.event.name, body.event.timestamp, body.event.clientId ?? "", JSON.stringify(body.event.data ?? null)].join("|"))}`
      : null;
  if (eventId) {
    const claimed = await prisma.processedWebhook
      .create({ data: { webhookId: `ingest:${shopDomain}:${eventId}`, shopDomain, topic: "ingest" } })
      .then(() => true)
      .catch(() => false); // create failed → row already exists → this event was already ingested
    if (!claimed) return;
  }

  // Buffer for the Live events inspector (cap 50/shop). PII is redacted before storage. Best-effort:
  // a buffer-write failure must not abort delivery (every other DB call in this path is best-effort too).
  await prisma.recentEvent
    .create({
      data: {
        shopDomain,
        name: body.event?.name ?? "event",
        platform: body.platform ?? null,
        payload: JSON.stringify({ platforms: body.platforms, event: redactEvent(body.event) }).slice(0, 4000),
      },
    })
    .catch(() => {});
  // Cap the buffer at ~50/shop. Prune probabilistically (not on every event) to avoid a
  // findMany+deleteMany on every storefront hit — see pruneCap.
  await pruneCap(prisma.recentEvent, shopDomain, 50);

  const event = { ...body.event, clientIp: body.event.clientIp || clientIp };
  // First-touch attribution: capture the source on UTM-tagged visits; on a conversion, attach the
  // visitor's original source so it isn't mis-credited to direct in a later/returning session.
  await recordVisit(shopDomain, event.clientId, event.utm);
  if (event.name === "checkout_completed") {
    event.firstTouch = await getFirstTouch(shopDomain, event.clientId);
  }

  // Delivery hooks: currency normalization (fx) + extra destinations (Google Ads Enhanced Conversions).
  // Both are no-ops unless the shop opted in; merged into one hooks object for buildJobs.
  const fx = await fxHooks(settings);
  const hooks = { ...fx, ...googleAdsHook(settings) };
  const results = await fanOutServerSide(settings, event, { hooks });
  await recordDeliveries(shopDomain, results);
  // Durable retry: queue any destination that failed so /cron/tick re-sends it with backoff.
  await enqueueFailures(shopDomain, results);
}
