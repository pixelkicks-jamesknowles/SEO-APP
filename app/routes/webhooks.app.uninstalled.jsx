import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Clear our stored sessions/offline token. Delete by `shop` unconditionally: on uninstall the
  // framework may not resolve a live `session`, and gating on it would leave the offline token behind
  // until shop/redact fires (up to 48h later).
  await prisma.session.deleteMany({ where: { shop } }).catch(() => {});
  return new Response();
};
