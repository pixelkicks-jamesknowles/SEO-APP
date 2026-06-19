import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createRedirect } from "../lib/admin-queries.server";
import { logError } from "../lib/log.server";

// Auto-301 on handle change (spec seo-app-v1 §4). Diff the product's current handle against the
// last one we stored; if it changed, create a 301 from the old storefront path to the new one so
// existing rankings/backlinks survive. First time we see a product, we just record its handle.
export const action = async ({ request }) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  const resourceId = payload?.admin_graphql_api_id;
  const handle = payload?.handle;
  if (!resourceId || !handle) return new Response();

  const key = { shopDomain_resourceId: { shopDomain: shop, resourceId } };
  const prior = await prisma.resourceHandle.findUnique({ where: key });

  if (prior && prior.handle !== handle && admin) {
    const result = await createRedirect(admin, `/products/${prior.handle}`, `/products/${handle}`);
    if (!result.ok) logError(`products/update redirect (${shop})`, result.error);
  }

  await prisma.resourceHandle.upsert({
    where: key,
    create: { shopDomain: shop, resourceId, resourceType: "product", handle },
    update: { handle },
  });

  // IndexNow: ping Bing/Yandex etc. that this URL changed (fire-and-forget).
  const seo = await prisma.seoSettings.findUnique({ where: { shopDomain: shop } });
  if (seo?.indexnowKey) {
    fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: shop,
        key: seo.indexnowKey,
        keyLocation: `https://${shop}/apps/pixelify-seo/indexnow`,
        urlList: [`https://${shop}/products/${handle}`],
      }),
    }).catch(() => {});
  }
  return new Response();
};
