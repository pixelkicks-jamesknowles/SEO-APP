// orders/cancelled -> server-side GA4 `refund` event for the full order. HMAC-verified, idempotent,
// best-effort. Gated on Server-side + Refund tracking.
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildCancellationEvent, buildSubscriptionCancellationEvent } from "../lib/refund";
import { syntheticClientId } from "../lib/subscription";
import { sendGa4Event } from "../lib/server-side.server";
import { recordDeliveries } from "../lib/delivery.server";

const refundEventName = (settings) => {
  try {
    return JSON.parse(settings?.subscriptionConfig || "{}").refundEventName || "subscription_refund";
  } catch {
    return "subscription_refund";
  }
};

export const action = async ({ request }) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  try {
    const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain: shop } });
    if (!settings?.serverSide || !settings?.refundTracking) return new Response();

    const dedupeKey = webhookId || `cancel:${payload?.id}`;
    const seen = await prisma.processedWebhook.findUnique({ where: { webhookId: dedupeKey } }).catch(() => null);
    if (seen) return new Response();

    const clientId = syntheticClientId(payload?.id);
    const event = buildCancellationEvent(payload, { clientId });
    const r = await sendGa4Event(settings, event);
    const deliveries = [{ destination: "ga4_refund", eventName: "refund", ok: r.sent, detail: r.detail }];
    // Reverse the subscription_purchase for the cancelled order's subscription lines.
    const subRefund = buildSubscriptionCancellationEvent(payload, { eventName: refundEventName(settings), clientId });
    if (subRefund) {
      const sr = await sendGa4Event(settings, subRefund);
      deliveries.push({ destination: "ga4_refund", eventName: subRefund.name, ok: sr.sent, detail: sr.detail });
    }
    await recordDeliveries(shop, deliveries);
    await prisma.processedWebhook
      .create({ data: { webhookId: dedupeKey, shopDomain: shop, topic: "orders/cancelled" } })
      .catch(() => {});
  } catch (e) {
    console.warn("[orders/cancelled] refund tracking:", e?.message || e);
  }
  return new Response();
};
