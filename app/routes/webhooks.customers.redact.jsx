import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { sha256Hex } from "../lib/server-side.server";

// GDPR customer redaction. We store no raw customer PII, but CustomerAttribution is keyed per customer
// (customer id, or a HASHED email when no customer is attached) to carry first-touch attribution across
// recurring orders. On a redaction request we delete those rows for the identified customer so nothing
// customer-linked survives. A row could have been keyed either way, so we delete both candidate keys.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const keys = [];
  if (payload?.customer?.id != null) keys.push(String(payload.customer.id));
  const email = payload?.customer?.email;
  if (email) keys.push(`e:${sha256Hex(email)}`);
  if (keys.length) {
    await prisma.customerAttribution
      .deleteMany({ where: { shopDomain: shop, customerKey: { in: keys } } })
      .catch(() => {});
  }
  console.log(`Received ${topic} for ${shop} — redacted ${keys.length} attribution key(s)`);
  return new Response();
};
