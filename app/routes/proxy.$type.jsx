import { authenticate } from "../shopify.server";
import { ingestEvent } from "../lib/ingest.server";

// App Proxy entrypoint - Shopify signs and forwards /apps/<subpath>/track here. Used by the SEO-
// engagement theme embed (main-page context, so it can hit the same-origin proxy). The Web Pixel can't
// use this (its strict sandbox blocks same-origin requests) and posts to /pixel/track instead.
//   track -> bot-filter, record the event, fan out server-side to GA4 / Meta CAPI / sGTM, log outcomes.
export const action = async ({ request, params }) => {
  const { session } = await authenticate.public.appProxy(request);
  const shopDomain = session?.shop;
  if (!shopDomain) return new Response("Unauthorized", { status: 401 });
  if (params.type !== "track") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => null);
  const clientIp = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || undefined;
  await ingestEvent(shopDomain, body, clientIp);
  return new Response(null, { status: 204 });
};
