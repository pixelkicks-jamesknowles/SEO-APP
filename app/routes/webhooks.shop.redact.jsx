import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR: 48h after uninstall, delete EVERYTHING we hold for the shop. This must cover every
// shop-scoped table — including the ones that hold PII (CustomerAttribution stores hashed emails)
// and credentials (GoogleToken) — or residual personal data / secrets survive a shop-deletion
// request. FxRate is intentionally excluded: it's a global, non-shop, non-personal rate snapshot.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} for ${shop} — purging shop data`);
  // Every model keyed on `shopDomain` (Session is keyed on `shop`). CronHeartbeat is intentionally
  // excluded — it's a single global (`_global`) worker-liveness row, not shop-scoped or personal.
  const byShopDomain = [
    prisma.trackingSettings,
    prisma.activityLog,
    prisma.recentEvent,
    prisma.deliveryLog,
    prisma.deliveryOutbox,
    prisma.trackingDaily,
    prisma.matchQualityDaily,
    prisma.pendingPurchase,
    prisma.pendingSubscription,
    prisma.purchaseCapture,
    prisma.processedWebhook,
    prisma.customerAttribution,
    prisma.customerLifetime,
    prisma.visitorAttribution,
    prisma.visitorIdentity,
    prisma.channelRevenueDaily,
    prisma.unattributedOrder,
    prisma.conversionPath,
    prisma.backfillJob,
    prisma.connectionCheck,
    prisma.alertDismissal,
    prisma.alertNotification,
    prisma.googleToken,
    prisma.shop,
  ];
  await Promise.all([
    ...byShopDomain.map((model) => model.deleteMany({ where: { shopDomain: shop } }).catch(() => {})),
    prisma.session.deleteMany({ where: { shop } }).catch(() => {}),
  ]);
  return new Response();
};
