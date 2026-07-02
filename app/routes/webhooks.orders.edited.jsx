// orders/edited → server-side GA4 `order_edited` lifecycle event carrying the NEW order total. The
// webhook payload is an order_edit summary (no clean total), so we re-fetch the order via the Admin
// API. HMAC-verified, idempotent, best-effort. Gated on Server-side + Lifecycle tracking. Distinct
// event name, so the purchase conversion is never double-counted.
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildOrderEditedEvent } from "../lib/lifecycle";
import { fetchOrderForEdit } from "../lib/lifecycle.server";
import { syntheticClientId } from "../lib/subscription";
import { sendGa4Event } from "../lib/server-side.server";
import { normalizeForShop } from "../lib/fx.server";
import { enqueue } from "../lib/outbox.server";
import { recordDeliveries } from "../lib/delivery.server";

export const action = async ({ request }) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  try {
    const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain: shop } });
    if (!settings?.serverSide || !settings?.lifecycleTracking) return new Response();

    const orderId = payload?.order_edit?.order_id ?? payload?.id;
    // Idempotency keyed on the edit id (an order can be edited more than once → new webhookId each time).
    const dedupeKey = webhookId || `edit:${payload?.order_edit?.id ?? orderId}`;
    const claimed = await prisma.processedWebhook
      .create({ data: { webhookId: dedupeKey, shopDomain: shop, topic: "orders/edited" } })
      .then(() => true)
      .catch(() => false);
    if (!claimed) return new Response();

    const order = await fetchOrderForEdit(shop, orderId);
    if (!order) return new Response(); // couldn't re-fetch → skip rather than send a wrong value
    const event = buildOrderEditedEvent(order, { clientId: syntheticClientId(orderId) });
    if (!event) return new Response();
    await normalizeForShop(settings, event.params); // multi-currency (no-op if off)
    const r = await sendGa4Event(settings, event);
    if (!r.sent && r.job) await enqueue(shop, r.job, r.detail);
    await recordDeliveries(shop, [{ destination: "ga4", eventName: event.name, ok: r.sent, detail: r.detail }]);
  } catch (e) {
    console.warn("[orders/edited] lifecycle tracking:", e?.message || e);
  }
  return new Response();
};
