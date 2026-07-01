import prisma from "../db.server";
import { fanOutServerSide, isBot } from "./server-side.server";
import { recordDeliveries, recordVisit, getFirstTouch } from "./delivery.server";
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

  // Buffer for the Live events inspector (cap 50/shop). PII is redacted before storage.
  await prisma.recentEvent.create({
    data: {
      shopDomain,
      name: body.event?.name ?? "event",
      platform: body.platform ?? null,
      payload: JSON.stringify({ platforms: body.platforms, event: redactEvent(body.event) }).slice(0, 4000),
    },
  });
  const stale = await prisma.recentEvent.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    skip: 50,
    select: { id: true },
  });
  if (stale.length) {
    await prisma.recentEvent.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }

  const event = { ...body.event, clientIp: body.event.clientIp || clientIp };
  // First-touch attribution: capture the source on UTM-tagged visits; on a conversion, attach the
  // visitor's original source so it isn't mis-credited to direct in a later/returning session.
  await recordVisit(shopDomain, event.clientId, event.utm);
  if (event.name === "checkout_completed") {
    event.firstTouch = await getFirstTouch(shopDomain, event.clientId);
  }

  const results = await fanOutServerSide(settings, event);
  await recordDeliveries(shopDomain, results);
}
