import { authenticate } from "../shopify.server";

// GDPR redaction request. No customer PII stored (see data_request) — nothing to redact.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} for ${shop} — no customer PII stored`);
  return new Response();
};
