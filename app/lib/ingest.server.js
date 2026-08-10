import prisma from "../db.server";
import { fanOutServerSide, isBot, sha256Hex, metaUserData, metaIdentifierKeys } from "./server-side.server";
import { recordDeliveries, recordVisit, getFirstTouch, pruneCap, bumpMatchQuality, recordConversionPath, bumpDaily } from "./delivery.server";
import { analyticsConsented } from "./consent";
import { enqueueFailures } from "./outbox.server";
import { recordCaptureFromResults, numericId } from "./reconcile.server";
import { fxHooks } from "./fx.server";
import { googleAdsHook } from "./google-ads.server";
import { cogsEnabled, resolveOrderCost } from "./cogs.server";
import { classifyOrderViaAdmin } from "./report-writeback.server";
import { visitorKey, eventCustomerKey, linkIdentity, resolveIdentityFirstTouch } from "./identity.server";
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
      ? `h:${sha256Hex([body.event.name, body.event.timestamp, body.event.clientId ?? "", JSON.stringify(body.event.data ?? null), JSON.stringify(body.event.params ?? null)].join("|"))}`
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

  // Consent-rate counter (Accuracy): every ingested storefront event is classified granted/denied by its
  // analytics-consent state, so the merchant can read the capture numbers against how many shoppers accept
  // their cookie banner. Best-effort.
  await bumpDaily(shopDomain, analyticsConsented(body.event.consent) ? { consentGranted: 1 } : { consentDenied: 1 });

  const event = { ...body.event, clientIp: body.event.clientIp || clientIp };
  // Durable first-party id (ITP-proof cookie minted by the app proxy): use it as the stable client id
  // when no _ga/_shopify_y id is present, so a returning visitor is ONE user/session across sessions
  // even after the short-lived cookies expire — and every server-side destination inherits that stability.
  if (!event.clientId && event.durableId) event.clientId = String(event.durableId);
  // First-touch attribution: capture the source on UTM-tagged visits; on a conversion, attach the
  // visitor's original source so it isn't mis-credited to direct in a later/returning session.
  // Key first-touch on the STABLE visitor key (durable id when present, else the GA4 client id) so a
  // returning visitor's original source survives _ga/ITP churn (cross-session). Record the identity
  // links (durableId ↔ clientId ↔ customer) so a conversion can be tied back across sessions/devices.
  const vkey = visitorKey(event);
  const customerKey = eventCustomerKey(event);
  await recordVisit(shopDomain, vkey, event.utm, event.referrer);
  await linkIdentity(shopDomain, { durableId: event.durableId, clientId: event.clientId, customerKey });
  if (event.name === "checkout_completed") {
    // First-touch: prefer this device's own recorded source; if it looks direct (no first-touch on this
    // device — e.g. the shopper first browsed on another device, or in a session whose _ga has churned),
    // fall back to the customer's earliest first-touch across every device linked via the identity graph.
    // This is the cross-device / cross-session stitching the graph exists for.
    event.firstTouch =
      (await getFirstTouch(shopDomain, vkey)) || (await resolveIdentityFirstTouch(shopDomain, customerKey, getFirstTouch));
    // True-profit (COGS) valuation: resolve the order's cost of goods from Shopify's per-variant cost so
    // buildJobs sends profit as the conversion value. Purchases are low-volume, so the extra Admin fetch
    // is off the page-view hot path; best-effort (null cost → withValueMode falls back to revenue).
    if (cogsEnabled(settings)) event.orderCost = await resolveOrderCost(shopDomain, event);
    // order_type / customer_type GA4 dimensions on the LIVE purchase. The pixel event has no orders_count
    // or selling-plan data, so classify via a best-effort Admin lookup (purchases are low-volume — this is
    // off the page-view hot path, same as the COGS fetch above). This is the ONLY send GA4 keeps for a
    // one-off order the pixel captured (the orders/paid server-side purchase would lose the transaction_id
    // dedup race), so the dimensions must ride THIS event. ga4EventFor merges event.params.
    const types = await classifyOrderViaAdmin(shopDomain, event.data?.checkout?.order?.id);
    if (types.orderType || types.customerType) {
      event.params = { ...(event.params || {}) };
      if (types.orderType) event.params.order_type = types.orderType;
      if (types.customerType) event.params.customer_type = types.customerType;
    }
    // Snapshot the visitor's touch path + order value for the multi-touch models (best-effort, idempotent).
    await recordConversionPath(shopDomain, vkey, event).catch(() => {});
    // NOTE: revenue-by-channel is NOT recorded here any more. It's driven from the orders/paid webhook
    // (Shopify's source of truth), because that is the only path that sees recurring subscription
    // renewals — they never fire a storefront checkout, so this pixel path silently excluded them and the
    // Attribution report was missing subscription revenue entirely. Recording it in both places would
    // double-count, so orders/paid owns it. See webhooks.orders.paid.jsx → recordOrderRevenue.
  }

  // Delivery hooks: currency normalization (fx) + extra destinations (Google Ads Enhanced Conversions).
  // Both are no-ops unless the shop opted in; merged into one hooks object for buildJobs.
  const fx = await fxHooks(settings);
  const hooks = { ...fx, ...googleAdsHook(settings) };
  const results = await fanOutServerSide(settings, event, { hooks });
  await recordDeliveries(shopDomain, results);
  // Durable retry: queue any destination that failed so /cron/tick re-sends it with backoff.
  await enqueueFailures(shopDomain, results);

  // Purchase-specific bookkeeping: stamp which destinations delivered (so the reconcile pass knows this
  // order was captured client-side and won't re-send it), and roll up Meta identifier coverage for the
  // match-quality diagnostics. Both keyed on the order id the pixel reported.
  if (event.name === "checkout_completed") {
    const orderId = numericId(event.data?.checkout?.order?.id);
    if (orderId) await recordCaptureFromResults(shopDomain, orderId, results);
    await bumpMatchQuality(shopDomain, metaIdentifierKeys(metaUserData(event)));
    // Order-level consent split (for the Accuracy "orders opted out of tracking" tile): count this order
    // by whether the shopper granted analytics consent, so the merchant can see their tracking blind spot.
    await bumpDaily(shopDomain, analyticsConsented(event.consent) ? { purchaseConsentGranted: 1 } : { purchaseConsentDenied: 1 });
  }
}
