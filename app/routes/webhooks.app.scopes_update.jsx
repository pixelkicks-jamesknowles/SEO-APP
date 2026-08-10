import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { provisionDefinitions } from "../lib/report-writeback.server";

export const action = async ({ request }) => {
  const { shop, session, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current ?? [];
  if (session) {
    await prisma.session.update({
      where: { id: session.id },
      data: { scope: current.toString() },
    });
  }
  // When the merchant grants the write-back scopes (re-consent), create the connect_analytics.* metafield
  // definitions so the fields become columns in their native report builder. Idempotent + best-effort, and
  // fired only when the scope is actually present (no point calling metafieldDefinitionCreate without it).
  if (current.includes("write_orders")) {
    unauthenticated
      .admin(shop)
      .then(({ admin }) => provisionDefinitions(admin))
      .catch((e) => console.warn("[scopes_update] provision definitions:", e?.message || e));
  }
  return new Response();
};
