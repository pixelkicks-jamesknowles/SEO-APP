import { authenticate } from "../shopify.server";

// GDPR: a customer (or merchant on their behalf) requested their stored data.
// pixelify-seo stores NO customer PII — only shop-level SEO/tracking config and
// aggregate 404 paths. Acknowledge with nothing to return.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} for ${shop} — no customer PII stored`);
  return new Response();
};
