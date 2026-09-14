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
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { bumpDaily, recordChannelRevenue, recordAcquisition, recordFirstSubscriptionOrder, recordLastSubscriptionOrder } from "../lib/delivery.server";
import { recordPendingPurchase } from "../lib/reconcile.server";
import { recordPendingSubscription, processSubscriptionNow } from "../lib/subscription-cron.server";
import { customerKey, orderChannel, orderHasJourney } from "../lib/attribution";
import { orderConsentState } from "../lib/consent";
import { orderHasSubscription, customerTypeOf, isFirstSubscriptionOrder, subscriptionLifecycleOf, parseIntervalDays, linePlanName } from "../lib/subscription";
import { writeOrderAttribution, writeCustomerAttribution, attributionValues } from "../lib/report-writeback.server";
import { stitchIdentityFromOrder } from "../lib/identity.server";

/**
 * Attribute a paid order's revenue to the channel that ACQUIRED the customer.
 *
 * First-touch, in priority order:
 *   1. CustomerAttribution — the source captured on this customer's FIRST order. A recurring renewal has
 *      no browser session and no UTMs of its own, so replaying the first-touch source is the only way it
 *      can carry a channel at all. This is the whole point.
 *   2. This order's own UTMs (a first-time buyer we haven't seen before).
 *   3. (direct)/(none).
 */
async function recordOrderRevenue(shop, order) {
  const key = customerKey(order);
  const first = key
    ? await prisma.customerAttribution.findUnique({ where: { shopDomain_customerKey: { shopDomain: shop, customerKey: key } } }).catch(() => null)
    : null;
  // This order's own channel: UTMs, else an auto-tagged click id (gclid/msclkid/…), else the referring
  // site. The customer's stored first touch still wins — a renewal has no journey of its own, and
  // replaying the channel that acquired them is the whole point of the report.
  const own = orderChannel(order) || {};
  const source = first?.source || own.source;
  const medium = first?.medium || own.medium;
  const campaign = first?.campaign || own.campaign;
  // With no channel at all, WHICH empty bucket this belongs in depends on whether we saw a journey. An
  // order with a landing/referring site that carried no marketing signal genuinely was direct; one with
  // neither (an API or imported order, a renewal) is unknowable. The backfill already keeps
  // "(unattributed)" as its own honest bucket rather than inflating Direct — this makes the live path
  // agree, so the two can be read side by side and a backfill doesn't appear to move revenue between them.
  const fallbackSource = orderHasJourney(order) ? "(direct)" : "(unattributed)";
  // new vs returning / subscription-checkout vs renewal vs one-off. orders_count on the webhook payload is
  // authoritative for "first order"; fall back to whether this IS the customer's recorded first order.
  const isFirstOrder = Number.isFinite(Number(order?.customer?.orders_count))
    ? Number(order.customer.orders_count) === 1
    : first?.firstOrderId
      ? first.firstOrderId === String(order?.id ?? "")
      : undefined;
  // order_type needs the customer's first SUBSCRIPTION order, not their first order of any kind — a
  // shopper who bought a one-off and subscribes later has orders_count > 1 on their genuine subscription
  // checkout, and feeding that in reported it as a renewal. Read the stored marker, classify against it,
  // then fill it in if this is the first subscription order we've seen for them.
  const isFirstSub = isFirstSubscriptionOrder(order, first?.firstSubscriptionOrderId);
  // order_type, now including "reactivation" — a lapsed subscriber who came back, which is otherwise
  // indistinguishable from an ordinary renewal. Inferred from the gap since their last subscription
  // order against its cadence, so it's indicative: a PAUSED subscription resuming looks the same.
  const orderType = subscriptionLifecycleOf(order, {
    firstSubscriptionOrderId: first?.firstSubscriptionOrderId,
    lastSubscriptionOrderAt: first?.lastSubscriptionOrderAt,
    lastSubscriptionIntervalDays: first?.lastSubscriptionIntervalDays,
  });
  const customerType = customerTypeOf(order, { isFirstOrder });
  if (key && isFirstSub && !first?.firstSubscriptionOrderId) {
    await recordFirstSubscriptionOrder(shop, key, order?.id);
  }
  // Move the "last subscription order" marker forward so the NEXT one can be measured against it. The
  // cadence comes from the selling-plan name on the order; the Admin-resolved interval is only available
  // on the deferred subscription pipeline, and this needs to stay off the webhook's hot path.
  if (key && orderHasSubscription(order)) {
    const planDays = (order?.line_items || []).map((l) => parseIntervalDays(linePlanName(l))).find((d) => d > 0);
    await recordLastSubscriptionOrder(shop, key, { at: order?.created_at, intervalDays: planDays });
  }
  const revenue = Number(order?.current_total_price ?? order?.total_price ?? 0);
  await recordChannelRevenue(shop, {
    source: source || fallbackSource,
    medium,
    // Raw order revenue (not the margin/COGS-adjusted conversion value) — this report answers
    // "which channel drove sales", so it must be the real money.
    revenue,
    isSubscription: orderHasSubscription(order),
  });
  // Richer split for the new report (channel × campaign × order type × customer type).
  await recordAcquisition(shop, { source: source || fallbackSource, medium, campaign, orderType, customerType, revenue });
  // Values for the native-reporting write-back (metafields). acquisitionDate = when we first saw this
  // customer (their acquiring order), else this order's date for a brand-new customer.
  return { source, medium, campaign, orderType, customerType, acquisitionDate: first?.createdAt || order?.created_at, customerId: order?.customer?.id };
}

/**
 * Stamp the resolved attribution onto the native Shopify order (and customer) as connect_analytics.*
 * metafields, so it's groupable inside Shopify's own Analytics → Reports and usable in segments. Runs
 * fire-and-forget AFTER the webhook records (never blocks the ACK); needs write_orders / write_customers
 * and no-ops cleanly if a store hasn't re-consented yet. Best-effort. metafieldsSet is an upsert, so the
 * once-per-order ProcessedWebhook gate plus re-run safety mean this can never double-write.
 */
async function writeBackAttribution(shop, order, attrib) {
  const { admin } = await unauthenticated.admin(shop);
  const values = attributionValues(attrib);
  await writeOrderAttribution(admin, order?.id, values);
  if (attrib.customerId) await writeCustomerAttribution(admin, attrib.customerId, values);
}

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

    // Order-level analytics consent, from the note attribute the theme embed writes. Counted HERE rather
    // than on the pixel path because orders/paid sees EVERY paid order — the pixel only reports consent
    // for checkouts it observed, which is why this tile read zero. Orders with no attribute stay
    // uncounted and are derived as (ordersPaid - granted - denied) on the Accuracy page, so "we don't
    // know" stays visible instead of being silently scored as acceptance.
    const consent = orderConsentState(payload);
    if (consent !== "unknown") {
      await bumpDaily(shop, consent === "granted" ? { purchaseConsentGranted: 1 } : { purchaseConsentDenied: 1 });
    }

    // Revenue-by-channel for the Attribution report. Done HERE, not on the pixel path, because orders/paid
    // is the only thing that sees recurring subscription renewals — they never fire a storefront checkout,
    // so the pixel never saw them and their revenue was absent from the report entirely. The renewal
    // inherits the customer's FIRST-TOUCH source (the channel that acquired the subscriber), which is
    // precisely the number GA4 cannot produce: with no browser session there's no session to take a
    // channel from, so GA4 reports it as Unassigned forever. Guarded by the idempotency gate above.
    // Identity stitch: attach this customer to the durable visitor identities the theme embed recorded
    // against their GA client id. Done HERE, not (only) on the pixel path, because the pixel can rarely
    // supply both halves — its checkout event carries a customer identifier only for a LOGGED-IN shopper
    // with marketing consent, and its client id may differ from the one the embed stored. The order
    // carries the real customer key AND the embed's OWN `ga_client_id` note attribute, so this join is
    // against our own id and cannot mismatch. Without it, `identified` sat at 0 on a store with ~24k
    // visitors that all had a client id. Cheap (one guarded updateMany) and fill-in only, so it stays
    // inline ahead of the ACK. Best-effort, like everything else here.
    await stitchIdentityFromOrder(shop, payload).catch(() => 0);

    const attrib = await recordOrderRevenue(shop, payload).catch(() => null);
    // Fire-and-forget the metafield write-back (off the ACK hot path, like processSubscriptionNow below).
    if (attrib) writeBackAttribution(shop, payload, attrib).catch((e) => console.warn("[orders/paid] writeback:", e?.message || e));

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
