import { gql } from "./graphql.server";

// Shared deterministic SEO template application — used by the SEO route and the auto-apply webhook.

// {{ var }} substitution, no AI. Unknown tokens render empty; whitespace collapsed.
export function renderTemplate(tpl, ctx) {
  if (!tpl) return "";
  return tpl
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => ctx[k] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

const PRODUCT_SEO_UPDATE = `#graphql
  mutation SetProductSeo($product: ProductUpdateInput!) {
    productUpdate(product: $product) { userErrors { field message } }
  }`;

// Render title + description from templates and write them to one product's SEO fields.
// `product` accepts either GraphQL (productType) or webhook (product_type) field shapes.
export async function applyProductSeo(admin, tpls, shopName, product) {
  const ctx = {
    "product.title": product.title,
    "product.type": product.productType ?? product.product_type ?? "",
    "product.vendor": product.vendor ?? "",
    "shop.name": shopName ?? "",
  };
  const seo = {};
  const title = renderTemplate(tpls.product, ctx);
  const description = renderTemplate(tpls.productDescription, ctx);
  if (title) seo.title = title;
  if (description) seo.description = description;
  if (!Object.keys(seo).length || !product.id) return { applied: false, error: null };

  const json = await gql(admin, PRODUCT_SEO_UPDATE, { product: { id: product.id, seo } });
  const errs = json.errors ?? json.data?.productUpdate?.userErrors ?? [];
  return { applied: errs.length === 0, error: errs.length ? errs.map((e) => e.message).join("; ") : null };
}
