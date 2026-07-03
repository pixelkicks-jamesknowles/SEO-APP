import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { sha256Hex, numericId } from "../lib/server-side.server";

// GDPR customer redaction. We store no raw customer PII in our own tables, but several rows can be
// linked to a customer and must be purged:
//   - CustomerAttribution — keyed per customer (customer id, or a HASHED email when no customer is
//     attached) to carry first-touch attribution across recurring orders. A row could be keyed either
//     way, so we delete both candidate keys.
//   - PendingPurchase / PurchaseCapture — order-keyed reconciliation state. PendingPurchase carries the
//     customer's hashed Meta identifiers (pseudonymous personal data), so we purge the rows for every
//     order in the redaction request's `orders_to_redact`.
//   - VisitorAttribution — keyed on the GA4 client_id (client_id + UTM source/medium/campaign, which is
//     pseudonymous personal data). The redaction payload carries no client_id, BUT CustomerAttribution
//     captured this customer's client_id at first checkout, so we resolve it from there and purge the
//     matching visitor row(s) before deleting the CustomerAttribution mapping.
// DeliveryOutbox rows (which can carry raw Klaviyo PII for onsite events) aren't order- or customer-keyed
// and are encrypted at rest + purged by the cron shortly after delivery/dead-lettering, so there's no
// reliable per-customer selector for them here.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const keys = [];
  if (payload?.customer?.id != null) keys.push(String(payload.customer.id));
  const email = payload?.customer?.email;
  if (email) keys.push(`e:${sha256Hex(email)}`);
  let visitorPurged = 0;
  if (keys.length) {
    // Resolve the customer's client_id(s) from the attribution mapping BEFORE deleting it, then purge the
    // matching VisitorAttribution rows (otherwise that visitor's client_id + UTMs survive the redaction).
    const attrs = await prisma.customerAttribution
      .findMany({ where: { shopDomain: shop, customerKey: { in: keys } }, select: { clientId: true } })
      .catch(() => []);
    const clientIds = [...new Set(attrs.map((a) => a.clientId).filter(Boolean))];
    if (clientIds.length) {
      const del = await prisma.visitorAttribution
        .deleteMany({ where: { shopDomain: shop, clientId: { in: clientIds } } })
        .catch(() => ({ count: 0 }));
      visitorPurged = del?.count ?? 0;
    }
    await prisma.customerAttribution
      .deleteMany({ where: { shopDomain: shop, customerKey: { in: keys } } })
      .catch(() => {});
  }

  // Purge reconciliation state for the customer's orders (order-keyed, so exactly targetable).
  const orderIds = [...new Set((payload?.orders_to_redact || []).map((o) => numericId(o)).filter(Boolean))];
  if (orderIds.length) {
    await Promise.all([
      prisma.pendingPurchase.deleteMany({ where: { shopDomain: shop, orderId: { in: orderIds } } }).catch(() => {}),
      prisma.purchaseCapture.deleteMany({ where: { shopDomain: shop, orderId: { in: orderIds } } }).catch(() => {}),
    ]);
  }
  console.log(`Received ${topic} for ${shop} — redacted ${keys.length} attribution key(s), ${visitorPurged} visitor row(s), ${orderIds.length} order(s)`);
  return new Response();
};
