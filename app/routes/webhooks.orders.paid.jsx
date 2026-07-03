// orders/paid → record the paid order for tracking, then ACK fast. HMAC is verified by
// authenticate.webhook. Idempotent (ProcessedWebhook). Best-effort: always 200 once accepted so Shopify
// never retries (which would duplicate).
//
// This handler MUST return well inside Shopify's 5s webhook timeout, so it does NO slow work inline: it
// counts the order, records it for purchase reconciliation, and — for subscription orders — records it
// then kicks off delivery in the background (not awaited). The subscription conversion pipeline (Admin
// selling-plan lookups, COGS, FX and two GA4 sends) is what pushed webhook response time toward the
// timeout; it now runs AFTER the 200 via processSubscriptionNow (so GA4 sees the conversion in seconds),
// with /cron/tick's processPendingSubscriptions as the durable backstop if this process dies mid-flight
// and the outbox retrying any failed send.
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpDaily } from "../lib/delivery.server";
import { recordPendingPurchase } from "../lib/reconcile.server";
import { recordPendingSubscription, processSubscriptionNow } from "../lib/subscription-cron.server";

export const action = async ({ request }) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  try {
    // Idempotency FIRST — Shopify can deliver a webhook more than once. This gate guards the ordersPaid
    // counter AND the recorded rows below; without it, a redelivery double-counts ordersPaid (silently
    // depressing the Accuracy match-rate denominator) and re-queues the subscription order.
    const dedupeKey = webhookId || `order:${payload?.id}`;
    const seen = await prisma.processedWebhook.findUnique({ where: { webhookId: dedupeKey } }).catch(() => null);
    if (seen) return new Response();
    // Mark processed up front so a retry is a clean no-op. Best-effort (like the whole webhook): we
    // always 200 so Shopify never retries, so there's no record worth un-marking on a later failure.
    await prisma.processedWebhook
      .create({ data: { webhookId: dedupeKey, shopDomain: shop, topic: "orders/paid" } })
      .catch(() => {}); // a race just means another delivery already claimed it

    // Count every paid order (Shopify's source of truth) for the Accuracy match-rate, regardless of
    // whether subscription tracking is on.
    await bumpDaily(shop, { ordersPaid: 1 });

    const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain: shop } });

    // Reconciliation: record EVERY paid order so a delayed cron pass can backfill the GA4/Meta purchase
    // if the storefront pixel never delivered it.
    await recordPendingPurchase(shop, payload, settings);

    // Subscription conversions are slow to build and deliver, so we don't BLOCK on them: we record the
    // order (a single cheap encrypted upsert), then kick off immediate delivery WITHOUT awaiting it — so
    // the webhook still ACKs fast, but the conversion reaches GA4 in seconds rather than on the next cron
    // tick. The kick leases the row first, so /cron/tick's processPendingSubscriptions (the backstop) can't
    // also process it; if this process dies mid-flight, the row stays pending and the next tick finishes it.
    if (settings?.serverSide && settings?.subscriptionTracking) {
      await recordPendingSubscription(shop, payload);
      processSubscriptionNow(shop, payload, { settings }).catch((e) => console.warn("[orders/paid] immediate subscription:", e?.message || e));
    }
  } catch (e) {
    console.warn("[orders/paid] record:", e?.message || e);
  }
  return new Response();
};
