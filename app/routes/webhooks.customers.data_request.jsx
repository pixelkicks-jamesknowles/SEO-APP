import { authenticate } from "../shopify.server";

// GDPR: a customer (or merchant on their behalf) requested their stored data.
// pixelify-seo stores no raw customer PII at rest — only pseudonymous attribution (a HASHED email or
// customer id + a GA4 client_id / UTMs in CustomerAttribution + VisitorAttribution) and hashed Meta
// identifiers in reconciliation rows. Under Shopify's model this webhook is acknowledgment-only (the app
// returns nothing automatically); the customers/redact webhook is what actually purges those rows.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} for ${shop} — acknowledged (no PII returned automatically)`);
  return new Response();
};
