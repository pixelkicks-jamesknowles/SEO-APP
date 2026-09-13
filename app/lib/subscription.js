// Pure subscription-enrichment logic for the orders/paid → GA4 server-side event (no IO — unit-tested).
// M1 resolves the interval by PARSING the selling-plan name; M2 swaps in the Admin-API delivery policy
// as primary (subscription.server.js). Amounts use the actual charged figures from the order.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Interval in days from a selling-plan name. monthDays is configurable (client default 28). */
export function parseIntervalDays(name, { monthDays = 28 } = {}) {
  if (typeof name !== "string" || !name) return 0;
  const s = name.toLowerCase();
  const num = s.match(/(\d+)\s*(day|week|month|year)s?/);
  if (num) {
    const per = { day: 1, week: 7, month: monthDays, year: 365 }[num[2]];
    return parseInt(num[1], 10) * per;
  }
  if (/fortnight|bi[-\s]?week/.test(s)) return 14;
  if (/\bquarter/.test(s)) return 3 * monthDays;
  if (/week/.test(s)) return 7;
  if (/dai|\bday/.test(s)) return 1;
  if (/month/.test(s)) return monthDays;
  if (/year|annual/.test(s)) return 365;
  return 0;
}

/** A line is a subscription if it carries a selling plan (REST: selling_plan_allocation; GQL: sellingPlan). */
export function lineIsSubscription(line) {
  return !!(line?.selling_plan_allocation?.selling_plan || line?.sellingPlan);
}

export function linePlanName(line) {
  return line?.selling_plan_allocation?.selling_plan?.name || line?.sellingPlan?.name || "";
}

/** Deterministic GA4 client_id from the order id (Option B) — same order → same id, so the
 *  subscription_purchase event joins to the native purchase on transaction_id. */
export function syntheticClientId(orderId) {
  const s = String(orderId ?? "0");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `${h}.${(s.match(/\d+/)?.[0] || "0").slice(0, 10)}`;
}

/** Read a Shopify note_attribute (e.g. ga_client_id captured at checkout — Option A). */
export function noteAttr(order, name) {
  const a = (order?.note_attributes || []).find((x) => x?.name === name);
  return a?.value || null;
}

/** M1 consent heuristic: only send when the order shows marketing/analytics consent. */
export function orderHasAnalyticsConsent(order) {
  return order?.buyer_accepts_marketing === true;
}

/** True if the order is subscription revenue.
 *
 *  A Shopify selling plan on a line is the primary signal. The Recharge marker is a REQUIRED second
 *  signal: when Recharge runs on its OWN checkout (rather than Shopify Checkout Integration) it creates
 *  Shopify orders with no selling plan at all, marked only by its note attribute / tags. Without this
 *  fallback those renewals were classified `renewal` by orderTypeOf (which does read the marker) but
 *  recorded with isSubscription=false by orders/paid — so their revenue never landed in
 *  subscriptionRevenue and the app's subscription totals ran structurally short against Recharge. */
export function orderHasSubscription(order) {
  if ((order?.line_items || []).some(lineIsSubscription)) return true;
  return rechargeOrderType(order) !== null;
}

/** Read Recharge's subscription_order_type off the order, if present. Recharge keys it per Shopify order id
 *  and surfaces it as a note_attribute (preferred) or on the order tags. Returns the normalized Recharge
 *  value ("checkout_subscription" | "recurring_subscription") or null if we can't find it. */
export function rechargeOrderType(order) {
  const na = (noteAttr(order, "subscription_order_type") || "").toLowerCase();
  if (na.includes("checkout_subscription")) return "checkout_subscription";
  if (na.includes("recurring_subscription")) return "recurring_subscription";
  // Fallback to tags — Recharge also tags orders. Accept its raw values and its human-readable tags.
  const tags = String(order?.tags || "").toLowerCase();
  if (/\bcheckout_subscription\b|subscription first order/.test(tags)) return "checkout_subscription";
  if (/\brecurring_subscription\b|subscription recurring order|autorenew/.test(tags)) return "recurring_subscription";
  return null;
}

/**
 * True when this order is the customer's FIRST subscription order — the checkout that created the
 * subscription, as opposed to a renewal.
 *
 * This is deliberately NOT "is this their first order". A shopper can buy a one-off and subscribe later,
 * and a reactivated subscriber has plenty of prior orders; both have orders_count > 1 on a genuine
 * subscription checkout, which is why deriving this from orders_count reported them as renewals.
 *
 * `recordedId` is the firstSubscriptionOrderId stored against the customer — seeded oldest-first by the
 * attribution backfill from their real order history, then maintained by the live orders/paid path. When
 * nothing is recorded this is the first subscription order we have ever seen for them, so it counts as
 * the checkout; that is why the backfill seed matters, or an established subscriber's next renewal reads
 * as a new subscription exactly once. Pure.
 */
export function isFirstSubscriptionOrder(order, recordedId) {
  if (!orderHasSubscription(order)) return false;
  if (!recordedId) return true;
  return String(recordedId) === String(order?.id ?? "");
}

/**
 * How many billing cycles a subscription may be late before we call it a REACTIVATION rather than a
 * renewal. 2.5x the interval: a monthly subscriber who orders 40 days later is a late renewal, one who
 * orders 90 days later lapsed and came back. Deliberately generous, because over-calling reactivation is
 * the worse error — it would inflate "new subscribers" with people who were merely late.
 */
export const REACTIVATION_CYCLE_MULTIPLIER = 2.5;
/** Floor for the gap, for subscriptions with no resolvable cadence (defaults to a ~28-day cycle). */
export const DEFAULT_INTERVAL_DAYS = 28;

/**
 * Subscription lifecycle for an order: "subscription_checkout" | "reactivation" | "renewal" | "one_off".
 *
 * This is order_type plus one extra distinction — a subscriber who lapsed and came back, which
 * orderTypeOf reports as a plain "renewal" because from a single order the two are identical.
 *
 * ⚠️ INFERRED, NOT OBSERVED. The app subscribes to no subscription-contract webhooks and stores no
 * contract state, so all it has is the gap between a customer's subscription orders measured against
 * their billing cadence. That means a PAUSED subscription which later resumes is indistinguishable from
 * a cancelled one that restarts, and both report as a reactivation. Exact separation needs contract-level
 * data (Shopify subscription_contracts/* or the Recharge API). Treat this number as indicative.
 *
 *   prior = { lastSubscriptionOrderAt, lastSubscriptionIntervalDays, firstSubscriptionOrderId }
 * Pure.
 */
export function subscriptionLifecycleOf(order, prior = {}, { now } = {}) {
  const base = orderTypeOf(order, { isFirstSubscriptionOrder: isFirstSubscriptionOrder(order, prior?.firstSubscriptionOrderId) });
  if (base !== "renewal") return base;
  const last = prior?.lastSubscriptionOrderAt ? new Date(prior.lastSubscriptionOrderAt).getTime() : NaN;
  if (!Number.isFinite(last)) return "renewal"; // no history to measure a gap against
  const at = order?.created_at ? new Date(order.created_at).getTime() : now ?? Date.now();
  if (!Number.isFinite(at)) return "renewal";
  const gapDays = (at - last) / 86_400_000;
  if (!(gapDays > 0)) return "renewal"; // out-of-order delivery — never guess from a negative gap
  const interval = Number(prior?.lastSubscriptionIntervalDays) > 0 ? Number(prior.lastSubscriptionIntervalDays) : DEFAULT_INTERVAL_DAYS;
  return gapDays > interval * REACTIVATION_CYCLE_MULTIPLIER ? "reactivation" : "renewal";
}

/**
 * Classify an order's TYPE for GA4 / reporting: "subscription_checkout" | "renewal" | "one_off".
 * Recharge's marker wins when present; otherwise a subscription order is a checkout when it's the
 * customer's FIRST subscription order (isFirstSubscriptionOrder) and a renewal otherwise, and an order
 * with no subscription line is a one-off. Pure.
 */
export function orderTypeOf(order, { isFirstSubscriptionOrder } = {}) {
  const rc = rechargeOrderType(order);
  if (rc === "checkout_subscription") return "subscription_checkout";
  if (rc === "recurring_subscription") return "renewal";
  if (!orderHasSubscription(order)) return "one_off";
  // Subscription order with no explicit Recharge marker: first one for the customer = the checkout that
  // created the subscription; any later one = a renewal.
  return isFirstSubscriptionOrder ? "subscription_checkout" : "renewal";
}

/**
 * Classify the CUSTOMER on an order as "new" | "returning" (or null when unknown). Shopify's
 * customer.orders_count is authoritative and present on webhook payloads (== 1 → this is their first
 * order). Falls back to an explicit isFirstOrder signal (our CustomerAttribution.firstOrderId) when the
 * count is absent (e.g. a client-side pixel event). Pure.
 */
export function customerTypeOf(order, { isFirstOrder } = {}) {
  const oc = Number(order?.customer?.orders_count);
  if (Number.isFinite(oc) && oc > 0) return oc === 1 ? "new" : "returning";
  if (typeof isFirstOrder === "boolean") return isFirstOrder ? "new" : "returning";
  return null;
}

/** Numeric selling-plan id for a line (REST selling_plan_allocation / GraphQL sellingPlan), or null.
 *  Used to look the line's cadence up in an `intervals` map resolved from the Admin API. */
export function linePlanId(line) {
  const id = line?.selling_plan_allocation?.selling_plan?.id ?? line?.sellingPlan?.id;
  if (id == null) return null;
  return String(id).match(/\d+/g)?.pop() || null;
}

/** Normalize one Shopify REST order line into a GA4 item (net-of-discount unit price + subscription tags).
 *  intervals (optional): { [sellingPlanId]: days } resolved from the Admin API — authoritative when
 *  present; otherwise the interval falls back to parsing the selling-plan name. */
function toGaLine(l, monthDays, intervals) {
  const qty = Math.max(1, Number(l.quantity) || 1);
  const gross = (Number(l.price) || 0) * qty;
  const disc = Number(l.total_discount) || 0;
  const isSub = lineIsSubscription(l);
  const planId = linePlanId(l);
  const resolved = planId && intervals ? intervals[planId] : undefined;
  return {
    item_id: l.sku || String(l.variant_id || ""),
    item_name: l.title || "",
    item_variant: l.variant_title || "",
    price: round2((gross - disc) / qty),
    quantity: qty,
    discount: round2(disc / qty),
    // Numeric 1/0 (not a boolean): GA4 coerces booleans on item params inconsistently (true→"1",
    // false→"false"), so we send an explicit integer for a clean, consistent custom-dimension value.
    item_subscription: isSub ? 1 : 0,
    item_subscription_interval: isSub ? (resolved ?? parseIntervalDays(linePlanName(l), { monthDays })) : 0,
  };
}

const attach = (params, attribution) => {
  if (attribution?.source) params.source = attribution.source;
  if (attribution?.medium) params.medium = attribution.medium;
  if (attribution?.campaign) params.campaign = attribution.campaign;
};

// order_type / customer_type custom dimensions (register them in GA4). Kept separate from attach() so the
// one-off / reconcile / ingest paths can set them without touching first-touch source.
const attachTypes = (params, { orderType, customerType } = {}) => {
  if (orderType) params.order_type = orderType;
  if (customerType) params.customer_type = customerType;
};

/** Build the GA4 `subscription_purchase` event — SCOPED TO THE SUBSCRIPTION LINE ITEMS ONLY:
 *  items = subscription lines, value = their line-item subtotal (net of line discounts, no order-level
 *  tax/shipping). The regular `purchase` event (buildOrderPurchaseEvent) carries the whole order.
 *  attribution (optional) carries the first-order source so recurring orders keep the original one. */
export function buildSubscriptionEvent(order, { eventName = "subscription_purchase", monthDays = 28, clientId, sessionId, timestampMicros, attribution, intervals, orderType, customerType } = {}) {
  const subItems = (order?.line_items || []).map((l) => toGaLine(l, monthDays, intervals)).filter((i) => i.item_subscription);
  const params = {
    transaction_id: String(order?.id ?? ""),
    // Subscription-only subtotal — the sum of the subscription lines' net totals (price × qty).
    value: round2(subItems.reduce((s, i) => s + i.price * i.quantity, 0)),
    currency: order?.currency || "USD",
    // Numeric 1/0 for the same reason as item_subscription (consistent GA4 custom-dimension value).
    subscription: subItems.length > 0 ? 1 : 0,
    // Order-level interval = the first subscription line's; per-item intervals are authoritative.
    subscription_interval: subItems[0]?.item_subscription_interval || 0,
    items: subItems,
  };
  const coupon = order?.discount_codes?.[0]?.code;
  if (coupon) params.coupon = coupon;
  attach(params, attribution);
  attachTypes(params, { orderType, customerType });
  return { name: eventName, params, clientId, sessionId, timestampMicros };
}

/** Build the regular GA4 `purchase` event for a subscription order (fired server-side from
 *  orders/paid so it doesn't depend on the pixel/consent). Carries the WHOLE order — all line items,
 *  full value, tax + shipping — matching a normal purchase. transaction_id = order id. */
export function buildOrderPurchaseEvent(order, { eventName = "purchase", monthDays = 28, clientId, sessionId, timestampMicros, attribution, intervals, orderType, customerType } = {}) {
  const items = (order?.line_items || []).map((l) => toGaLine(l, monthDays, intervals));
  const params = {
    transaction_id: String(order?.id ?? ""),
    value: Number(order?.current_total_price ?? order?.total_price ?? 0),
    currency: order?.currency || "USD",
    tax: Number(order?.current_total_tax ?? 0),
    shipping: Number(order?.total_shipping_price_set?.shop_money?.amount ?? 0),
    items,
  };
  const coupon = order?.discount_codes?.[0]?.code;
  if (coupon) params.coupon = coupon;
  attach(params, attribution);
  attachTypes(params, { orderType, customerType });
  return { name: eventName, params, clientId, sessionId, timestampMicros };
}
