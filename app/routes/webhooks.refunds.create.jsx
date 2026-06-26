// refunds/create -> server-side GA4 `refund` event (negative conversion). HMAC-verified, idempotent,
// best-effort. Gated on Server-side + Refund tracking.
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildRefundEvent } from "../lib/refund";
import { syntheticClientId } from "../lib/subscription";
import { sendGa4Event } from "../lib/server-side.server";
import { recordDeliveries } from "../lib/delivery.server";

export const action = async ({ request }) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  try {
    const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain: shop } });
    if (!settings?.serverSide || !settings?.refundTracking) return new Response();

    const dedupeKey = webhookId || `refund:${payload?.id}`;
    const seen = await prisma.processedWebhook.findUnique({ where: { webhookId: dedupeKey } }).catch(() => null);
    if (seen) return new Response();

    const event = buildRefundEvent(payload, { clientId: syntheticClientId(payload?.order_id) });
    const r = await sendGa4Event(settings, event);
    await recordDeliveries(shop, [{ destination: "ga4_refund", eventName: "refund", ok: r.sent, detail: r.detail }]);
    await prisma.processedWebhook
      .create({ data: { webhookId: dedupeKey, shopDomain: shop, topic: "refunds/create" } })
      .catch(() => {});
  } catch (e) {
    console.warn("[refunds/create] refund tracking:", e?.message || e);
  }
  return new Response();
};
