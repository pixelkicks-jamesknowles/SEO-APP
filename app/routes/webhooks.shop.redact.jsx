import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR: 48h after uninstall, delete everything we hold for the shop.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} for ${shop} — purging shop data`);
  await Promise.all([
    prisma.seoSettings.deleteMany({ where: { shopDomain: shop } }),
    prisma.trackingSettings.deleteMany({ where: { shopDomain: shop } }),
    prisma.redirect404Log.deleteMany({ where: { shopDomain: shop } }),
    prisma.shop.deleteMany({ where: { shopDomain: shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);
  return new Response();
};
