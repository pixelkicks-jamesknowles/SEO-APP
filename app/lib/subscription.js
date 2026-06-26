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

function linePlanName(line) {
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

/** Build the GA4 `subscription_purchase` event (name + params + clientId). attribution (optional)
 *  carries the first-order source/medium/campaign so recurring orders keep the original attribution. */
export function buildSubscriptionEvent(order, { eventName = "subscription_purchase", monthDays = 28, clientId, attribution } = {}) {
  const lines = order?.line_items || [];
  const items = lines.map((l) => {
    const qty = Math.max(1, Number(l.quantity) || 1);
    const gross = (Number(l.price) || 0) * qty;
    const disc = Number(l.total_discount) || 0;
    const isSub = lineIsSubscription(l);
    return {
      item_id: l.sku || String(l.variant_id || ""),
      item_name: l.title || "",
      item_variant: l.variant_title || "",
      price: round2((gross - disc) / qty),
      quantity: qty,
      discount: round2(disc / qty),
      item_subscription: isSub,
      item_subscription_interval: isSub ? parseIntervalDays(linePlanName(l), { monthDays }) : 0,
    };
  });
  const subItems = items.filter((i) => i.item_subscription);
  const params = {
    transaction_id: String(order?.id ?? ""),
    value: Number(order?.current_total_price ?? order?.total_price ?? 0),
    currency: order?.currency || "USD",
    tax: Number(order?.current_total_tax ?? 0),
    shipping: Number(order?.total_shipping_price_set?.shop_money?.amount ?? 0),
    subscription: subItems.length > 0,
    // Order-level interval = the first subscription line's; per-item intervals are authoritative.
    subscription_interval: subItems[0]?.item_subscription_interval || 0,
    items,
  };
  const coupon = order?.discount_codes?.[0]?.code;
  if (coupon) params.coupon = coupon;
  // First-touch attribution (recurring orders inherit the original order's source).
  if (attribution?.source) params.source = attribution.source;
  if (attribution?.medium) params.medium = attribution.medium;
  if (attribution?.campaign) params.campaign = attribution.campaign;
  return { name: eventName, params, clientId };
}
