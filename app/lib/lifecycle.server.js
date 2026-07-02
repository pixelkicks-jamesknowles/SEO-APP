// Admin-API fetch of an order's current totals + line items for the orders/edited lifecycle event.
// The orders/edited webhook payload is an `order_edit` summary (no clean total), so we re-fetch the
// order and read its post-edit total. Best-effort: any failure returns null so the webhook skips.
import { unauthenticated } from "../shopify.server";

const ORDER_TOTALS_QUERY = `#graphql
  query OrderTotals($id: ID!) {
    order(id: $id) {
      id
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 250) {
        nodes { sku quantity title variant { id } }
      }
    }
  }`;

const numId = (gid) => (gid == null ? null : String(gid).match(/\d+/g)?.pop() || null);

/** Re-fetch an edited order as a normalized shape the pure builder understands, or null on failure. */
export async function fetchOrderForEdit(shop, orderId) {
  if (!orderId) return null;
  try {
    const { admin } = await unauthenticated.admin(shop);
    const gid = String(orderId).startsWith("gid://") ? String(orderId) : `gid://shopify/Order/${orderId}`;
    const res = await admin.graphql(ORDER_TOTALS_QUERY, { variables: { id: gid } });
    const json = await res.json();
    const o = json?.data?.order;
    if (!o) return null;
    const money = o.currentTotalPriceSet?.shopMoney;
    return {
      id: numId(o.id) || String(orderId),
      current_total_price: money?.amount ?? 0,
      currency: money?.currencyCode || "USD",
      line_items: (o.lineItems?.nodes || []).map((n) => ({
        sku: n.sku || "",
        title: n.title || "",
        quantity: n.quantity || 1,
        variant_id: numId(n.variant?.id),
      })),
    };
  } catch (e) {
    console.warn("[orders/edited] order re-fetch failed:", e?.message || e);
    return null;
  }
}
