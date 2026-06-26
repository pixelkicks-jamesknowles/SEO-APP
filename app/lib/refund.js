// Pure builders for GA4 `refund` events from Shopify refund / cancellation payloads. Refunds feed
// GA4 (its standard `refund` event), and via GA4 -> Google Ads import they net off ad conversions,
// so campaigns stop optimising toward high-return orders. No IO here (unit-tested).

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
  const refundTxns = txns.filter((t) => !t.kind || t.kind === "refund");
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
