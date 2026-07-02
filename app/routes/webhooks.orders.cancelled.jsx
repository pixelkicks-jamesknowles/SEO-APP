// orders/cancelled -> server-side GA4 `refund` event for the full order. HMAC-verified, idempotent,
// best-effort. Gated on Server-side + Refund tracking.
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildCancellationEvent, buildSubscriptionCancellationEvent } from "../lib/refund";
import { syntheticClientId } from "../lib/subscription";
import { fetchOrderSubscriptions } from "../lib/subscription.server";
import { sendGa4Event, withValueMode } from "../lib/server-side.server";
import { recordDeliveries } from "../lib/delivery.server";
import { enqueue } from "../lib/outbox.server";
import { normalizeForShop } from "../lib/fx.server";

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

    // Idempotency: mark processed UP FRONT (not after the send), so concurrent redeliveries can't both
    // pass the seen-check and each fire a duplicate GA4 refund. The unique webhookId makes create() the
    // atomic claim — losing the race means another delivery already owns this send, so bail.
    const dedupeKey = webhookId || `cancel:${payload?.id}`;
    const claimed = await prisma.processedWebhook
      .create({ data: { webhookId: dedupeKey, shopDomain: shop, topic: "orders/cancelled" } })
      .then(() => true)
      .catch(() => false);
    if (!claimed) return new Response();

    const clientId = syntheticClientId(payload?.id);
    const event = buildCancellationEvent(payload, { clientId });
    // Margin mode: reverse the same (margin) value the purchase sent.
    withValueMode(event.params, settings.valueMode, settings.marginPct);
    await normalizeForShop(settings, event.params); // multi-currency (no-op if off)
    const r = await sendGa4Event(settings, event);
    if (!r.sent && r.job) await enqueue(shop, r.job, r.detail); // durable retry
    const deliveries = [{ destination: "ga4_refund", eventName: "refund", ok: r.sent, detail: r.detail }];
    // REST payloads carry no selling-plan data, so pull it from the Admin API and graft it onto the
    // line items — then buildSubscriptionCancellationEvent can pick out the subscription lines.
    const { planByLineId } = await fetchOrderSubscriptions(shop, payload?.id);
    for (const line of payload.line_items || []) {
      const plan = planByLineId[String(line.id)];
      if (plan) line.selling_plan_allocation = { selling_plan: { id: plan.id, name: plan.name } };
    }
    // Reverse the subscription_purchase for the cancelled order's subscription lines.
    const subRefund = buildSubscriptionCancellationEvent(payload, { eventName: refundEventName(settings), clientId });
    if (subRefund) {
      await normalizeForShop(settings, subRefund.params);
      const sr = await sendGa4Event(settings, subRefund);
      if (!sr.sent && sr.job) await enqueue(shop, sr.job, sr.detail);
      deliveries.push({ destination: "ga4_refund", eventName: subRefund.name, ok: sr.sent, detail: sr.detail });
    }
    await recordDeliveries(shop, deliveries);
  } catch (e) {
    console.warn("[orders/cancelled] refund tracking:", e?.message || e);
  }
  return new Response();
};
