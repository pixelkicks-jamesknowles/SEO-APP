import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { applyProductSeo } from "../lib/apply-seo.server";
import { logActivity } from "../lib/activity.server";

const SHOP_NAME = `#graphql
  query { shop { name } }`;

// Auto-apply: when a product is created and the merchant has enabled it, write the SEO title +
// description from their saved templates. Create-only (not update) to avoid a productUpdate→
// products/update feedback loop.
export const action = async ({ request }) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  if (!admin) return new Response();

  const settings = await prisma.seoSettings.findUnique({ where: { shopDomain: shop } });
  if (!settings?.autoApply) return new Response();
  const tpls = JSON.parse(settings.metaTemplates ?? "{}");
  if (!tpls.product && !tpls.productDescription) return new Response();

  let shopName = "";
  try {
    const r = await admin.graphql(SHOP_NAME);
    shopName = (await r.json()).data?.shop?.name ?? "";
  } catch {
    // fall back to empty shop name
  }

  const product = {
    id: payload?.admin_graphql_api_id,
    title: payload?.title,
    product_type: payload?.product_type,
    vendor: payload?.vendor,
  };
  const result = await applyProductSeo(admin, tpls, shopName, product);
  if (result.applied) await logActivity(shop, "Auto-applied SEO", payload?.title ?? product.id);
  return new Response();
};
