// Pure builders for GA4 `refund` events from Shopify refund / cancellation payloads. Refunds feed
// GA4 (its standard `refund` event), and via GA4 -> Google Ads import they net off ad conversions,
// so campaigns stop optimising toward high-return orders. No IO here (unit-tested).
import { lineIsSubscription } from "./subscription";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function lineItem(li, quantity) {
  return {
    item_id: li?.sku || String(li?.variant_id || ""),
    item_name: li?.title || "",
    price: round2(li?.price),
    quantity: Math.max(1, Number(quantity) || 1),
  };
}

/** refunds/create payload -> GA4 `refund` event (partial or full). transaction_id matches the order. */
export function buildRefundEvent(refund, { clientId } = {}) {
  const txns = refund?.transactions || [];
  // Only sum transactions explicitly marked as refunds AND that actually settled — a `pending`/`failure`
  // refund transaction represents money not (yet) returned, so summing it over-states the reversal and
  // over-nets the conversion. Status is optional in some payloads, so absent status is treated as valid.
  // If none are marked as refunds (kind-less payload), fall back to summing all transactions rather than
  // mis-including a non-refund (e.g. a void/sale) line.
  const refundTxns = txns.filter((t) => t.kind === "refund" && (t.status == null || t.status === "success"));
  const value = round2((refundTxns.length ? refundTxns : txns).reduce((s, t) => s + (Number(t.amount) || 0), 0));
  const currency = txns[0]?.currency || "USD";
  const items = (refund?.refund_line_items || []).map((rli) => lineItem(rli.line_item, rli.quantity));
  const params = { transaction_id: String(refund?.order_id ?? ""), currency, value };
  if (items.length) params.items = items;
  return { name: "refund", params, clientId };
}

/** orders/cancelled payload (an order) -> a full GA4 `refund` event. */
export function buildCancellationEvent(order, { clientId } = {}) {
  const items = (order?.line_items || []).map((li) => lineItem(li, li?.quantity));
  const params = {
    transaction_id: String(order?.id ?? ""),
    currency: order?.currency || "USD",
    value: round2(order?.current_total_price ?? order?.total_price ?? 0),
  };
  if (items.length) params.items = items;
  return { name: "refund", params, clientId };
}

/** refunds/create payload -> GA4 `subscription_refund` reversing ONLY the subscription line items in
 *  the refund (partial refunds reverse only the refunded sub lines). Returns null when nothing
 *  subscription-related was refunded, so the caller can skip the send. Mirrors subscription_purchase. */
export function buildSubscriptionRefundEvent(refund, { eventName = "subscription_refund", clientId } = {}) {
  const rlis = (refund?.refund_line_items || []).filter((rli) => lineIsSubscription(rli?.line_item));
  if (!rlis.length) return null;
  const items = rlis.map((rli) => lineItem(rli.line_item, rli.quantity));
  // Prefer Shopify's per-line refunded subtotal; fall back to unit price × refunded quantity.
  const value = round2(
    rlis.reduce((s, rli) => {
      const sub = rli?.subtotal != null ? Number(rli.subtotal) : (Number(rli.line_item?.price) || 0) * (Number(rli.quantity) || 0);
      return s + sub;
    }, 0),
  );
  const currency = refund?.transactions?.[0]?.currency || "USD";
  const params = { transaction_id: String(refund?.order_id ?? ""), currency, value };
  if (items.length) params.items = items;
  return { name: eventName, params, clientId };
}

/** orders/cancelled payload -> GA4 `subscription_refund` reversing the subscription lines of the
 *  cancelled order (value = their net subtotal). Returns null when the order had no subscription line. */
export function buildSubscriptionCancellationEvent(order, { eventName = "subscription_refund", clientId } = {}) {
  const subLines = (order?.line_items || []).filter(lineIsSubscription);
  if (!subLines.length) return null;
  const items = subLines.map((li) => lineItem(li, li?.quantity));
  // Mirror buildSubscriptionEvent's value math EXACTLY (round the per-unit net, then × qty, then sum) so
  // the cancellation reverses to the same figure the subscription_purchase originally sent — otherwise
  // the two rounding paths can diverge by a cent and leave residual conversion value in the ad platform.
  const value = round2(
    subLines.reduce((s, li) => {
      const qty = Math.max(1, Number(li.quantity) || 1);
      const gross = (Number(li.price) || 0) * qty;
      const disc = Number(li.total_discount) || 0;
      return s + round2((gross - disc) / qty) * qty;
    }, 0),
  );
  const params = { transaction_id: String(order?.id ?? ""), currency: order?.currency || "USD", value };
  if (items.length) params.items = items;
  return { name: eventName, params, clientId };
}
