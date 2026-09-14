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
//   - VisitorAttribution — keyed on the VISITOR KEY (durableId || GA4 client_id) and holding UTM
//     source/medium/campaign + the capped 25-touch journey path. The redaction payload carries neither
//     identifier, so we resolve them from VisitorIdentity (below) and purge the matching row(s) first.
//   - VisitorIdentity — the identity graph: durableId <-> clientId <-> customerKey. Indexed on
//     (shopDomain, customerKey), so it is both the lookup table for the above AND a row to delete in its
//     own right — its customerKey can be the RAW Shopify customer id, not just a hashed email.
//     NEITHER of these two tables is TTL-purged by the cron, so anything missed here persists until the
//     shop uninstalls. They are the reason this webhook has to do a resolve-then-delete rather than a
//     flat set of deleteManys.
//   - CustomerLifetime — per-customer lifetime revenue/order totals, keyed per customer (id or hashed
//     email), same as CustomerAttribution. Delete both candidate keys.
//   - ConversionPath / UnattributedOrder — order-keyed rows carrying order value + touch path / order name.
//     Purged for every order in `orders_to_redact` (UnattributedOrder also by customer key, since it stores
//     one).
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
  let identityPurged = 0;
  if (keys.length) {
    // Resolve this customer's VISITOR KEYS from the identity graph BEFORE deleting it, then purge the
    // matching VisitorAttribution rows (otherwise that visitor's UTMs + 25-touch journey path survive the
    // redaction — and neither of these tables has a TTL purge, so "survives" means forever).
    //
    // This resolves from VisitorIdentity, NOT CustomerAttribution. It used to read
    // `CustomerAttribution.clientId`, which is a column nothing has ever written — so `clientIds` was
    // always empty, the delete never ran, and VisitorAttribution was silently never purged. (The unit
    // test mocked that column to a value production cannot produce, so it passed regardless.) The column
    // has since been dropped; VisitorIdentity is the table that actually carries the link, and it has an
    // index on (shopDomain, customerKey) for exactly this lookup.
    //
    // Both identifiers are collected per row because VisitorAttribution is keyed on the VISITOR KEY
    // (`visitorKey()` = durableId || clientId), so a given customer's rows may be filed under either —
    // see identity.server.js firstTouchFor, which looks up both for the same reason.
    const identities = await prisma.visitorIdentity
      .findMany({ where: { shopDomain: shop, customerKey: { in: keys } }, select: { durableId: true, clientId: true } })
      .catch(() => []);
    const visitorKeys = [...new Set(identities.flatMap((i) => [i.durableId, i.clientId]).filter(Boolean))];
    if (visitorKeys.length) {
      const del = await prisma.visitorAttribution
        .deleteMany({ where: { shopDomain: shop, clientId: { in: visitorKeys } } })
        .catch(() => ({ count: 0 }));
      visitorPurged = del?.count ?? 0;
    }
    const [, , identityDel] = await Promise.all([
      prisma.customerAttribution.deleteMany({ where: { shopDomain: shop, customerKey: { in: keys } } }).catch(() => {}),
      // Per-customer lifetime totals (LTV/retention) are keyed the same way.
      prisma.customerLifetime.deleteMany({ where: { shopDomain: shop, customerKey: { in: keys } } }).catch(() => {}),
      // The identity graph itself: durableId <-> clientId <-> customerKey. `customerKey` can be the RAW
      // Shopify customer id (eventCustomerKey returns event.externalId unhashed), so this is directly
      // identifying, not merely pseudonymous. Deleted last so the lookup above still sees it.
      prisma.visitorIdentity.deleteMany({ where: { shopDomain: shop, customerKey: { in: keys } } }).catch(() => ({ count: 0 })),
    ]);
    identityPurged = identityDel?.count ?? 0;
  }

  // Purge reconciliation + attribution state for the customer's orders (order-keyed, so exactly targetable).
  const orderIds = [...new Set((payload?.orders_to_redact || []).map((o) => numericId(o)).filter(Boolean))];
  if (orderIds.length || keys.length) {
    await Promise.all([
      orderIds.length ? prisma.pendingPurchase.deleteMany({ where: { shopDomain: shop, orderId: { in: orderIds } } }).catch(() => {}) : null,
      orderIds.length ? prisma.purchaseCapture.deleteMany({ where: { shopDomain: shop, orderId: { in: orderIds } } }).catch(() => {}) : null,
      // ConversionPath carries the order value + the visitor's touch path; order-keyed.
      orderIds.length ? prisma.conversionPath.deleteMany({ where: { shopDomain: shop, orderId: { in: orderIds } } }).catch(() => {}) : null,
      // UnattributedOrder carries order name + revenue + a customer key; purge by either selector.
      prisma.unattributedOrder.deleteMany({ where: { shopDomain: shop, OR: [{ orderId: { in: orderIds } }, { customerKey: { in: keys } }] } }).catch(() => {}),
    ]);
  }
  console.log(
    `Received ${topic} for ${shop} — redacted ${keys.length} attribution key(s), ${visitorPurged} visitor row(s), ` +
      `${identityPurged} identity row(s), ${orderIds.length} order(s)`,
  );
  return new Response();
};
