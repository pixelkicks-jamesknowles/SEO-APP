import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR: 48h after uninstall, delete EVERYTHING we hold for the shop. This must cover every
// shop-scoped table — including the ones that hold PII (CustomerAttribution stores hashed emails)
// and credentials (GoogleToken) — or residual personal data / secrets survive a shop-deletion
// request. FxRate is intentionally excluded: it's a global, non-shop, non-personal rate snapshot.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} for ${shop} — purging shop data`);
  // Every model keyed on `shopDomain` (Session is keyed on `shop`).
  const byShopDomain = [
    prisma.seoSettings,
    prisma.trackingSettings,
    prisma.redirect404Log,
    prisma.resourceHandle,
    prisma.activityLog,
    prisma.auditSnapshot,
    prisma.recentEvent,
    prisma.deliveryLog,
    prisma.deliveryOutbox,
    prisma.trackingDaily,
    prisma.matchQualityDaily,
    prisma.pendingPurchase,
    prisma.purchaseCapture,
    prisma.processedWebhook,
    prisma.customerAttribution,
    prisma.visitorAttribution,
    prisma.alertDismissal,
    prisma.googleToken,
    prisma.shop,
  ];
  await Promise.all([
    ...byShopDomain.map((model) => model.deleteMany({ where: { shopDomain: shop } }).catch(() => {})),
    prisma.session.deleteMany({ where: { shop } }).catch(() => {}),
  ]);
  return new Response();
};
