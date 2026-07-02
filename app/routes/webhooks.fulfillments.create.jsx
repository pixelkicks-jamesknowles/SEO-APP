// fulfillments/create → server-side GA4 `order_fulfilled` lifecycle event. HMAC-verified, idempotent,
// best-effort. Gated on Server-side + Lifecycle tracking. Distinct event name, so it never touches the
// purchase conversion.
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildFulfillmentEvent } from "../lib/lifecycle";
import { syntheticClientId } from "../lib/subscription";
import { sendGa4Event } from "../lib/server-side.server";
import { enqueue } from "../lib/outbox.server";
import { recordDeliveries } from "../lib/delivery.server";

export const action = async ({ request }) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  try {
    const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain: shop } });
    if (!settings?.serverSide || !settings?.lifecycleTracking) return new Response();

    // Idempotency: claim up front so concurrent redeliveries can't both send.
    const dedupeKey = webhookId || `fulfillment:${payload?.id}`;
    const claimed = await prisma.processedWebhook
      .create({ data: { webhookId: dedupeKey, shopDomain: shop, topic: "fulfillments/create" } })
      .then(() => true)
      .catch(() => false);
    if (!claimed) return new Response();

    const event = buildFulfillmentEvent(payload, { clientId: syntheticClientId(payload?.order_id) });
    if (!event) return new Response();
    const r = await sendGa4Event(settings, event);
    if (!r.sent && r.job) await enqueue(shop, r.job, r.detail);
    await recordDeliveries(shop, [{ destination: "ga4", eventName: event.name, ok: r.sent, detail: r.detail }]);
  } catch (e) {
    console.warn("[fulfillments/create] lifecycle tracking:", e?.message || e);
  }
  return new Response();
};
