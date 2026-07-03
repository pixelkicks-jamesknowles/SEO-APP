// Pure builders for post-purchase / lifecycle GA4 events (no IO — unit-tested):
//   - order_fulfilled  ← fulfillments/create (a Shopify Fulfillment payload)
//   - order_edited     ← orders/edited (built from the RE-FETCHED full order; carries the NEW total)
// Both use a DISTINCT event name (never "purchase"/"refund") so they add lifecycle visibility without
// touching the purchase conversion or double-counting it. transaction_id = the order id, so they join
// to the original purchase in GA4.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function toItem(li) {
  return {
    item_id: li?.sku || String(li?.variant_id || ""),
    item_name: li?.title || "",
    quantity: Math.max(1, Number(li?.quantity) || 1),
    price: round2(li?.price),
  };
}

/** fulfillments/create (Fulfillment) → GA4 `order_fulfilled`. Returns null without an order id. */
export function buildFulfillmentEvent(fulfillment, { eventName = "order_fulfilled", clientId } = {}) {
  const orderId = fulfillment?.order_id;
  if (orderId == null) return null;
  const items = (fulfillment?.line_items || []).map(toItem);
  const params = {
    transaction_id: String(orderId),
    shipment_status: fulfillment?.shipment_status || fulfillment?.status || "success",
  };
  if (fulfillment?.tracking_company) params.shipping_tier = fulfillment.tracking_company;
  if (items.length) params.items = items;
  return { name: eventName, params, clientId };
}

/** A re-fetched full order (current_total_price + line_items) → GA4 `order_edited` carrying the NEW
 *  order total, so an edited order's updated value is visible in analytics. Distinct from `purchase`,
 *  so it never double-counts the conversion. Returns null without an order id. */
export function buildOrderEditedEvent(order, { eventName = "order_edited", clientId, fallbackCurrency } = {}) {
  const orderId = order?.id;
  if (orderId == null) return null;
  const items = (order?.line_items || []).map(toItem);
  const params = {
    transaction_id: String(orderId),
    value: round2(order?.current_total_price ?? order?.total_price ?? 0),
    currency: order?.currency || fallbackCurrency || "USD",
  };
  if (items.length) params.items = items;
  return { name: eventName, params, clientId };
}
