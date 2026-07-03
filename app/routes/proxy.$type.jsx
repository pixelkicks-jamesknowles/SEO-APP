import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ingestEvent } from "../lib/ingest.server";
import { checkIngestRate, clientIpFromRequest } from "../lib/ratelimit.server";
import { effectiveDataLayerConfig } from "../lib/datalayer";

// App Proxy entrypoint - Shopify signs and forwards /apps/<subpath>/<type> here. Used by the SEO-
// engagement theme embed (main-page context, so it can hit the same-origin proxy). The Web Pixel can't
// use this (its strict sandbox blocks same-origin requests) and posts to /pixel/track instead.
//   GET  config -> the effective storefront config (GTM data-layer enabled flag + event list).
//   POST track  -> bot-filter, record the event, fan out server-side to GA4 / Meta CAPI / sGTM, log.
//
// GET /apps/<subpath>/config: the embed reads whether the (Pro) data layer is on. App-proxy-signed, so
// the shop is authenticated. Cached briefly so it's not re-fetched on every pageview of a session.
export const loader = async ({ request, params }) => {
  const { session } = await authenticate.public.appProxy(request);
  const shopDomain = session?.shop;
  if (!shopDomain) return new Response("Unauthorized", { status: 401 });
  if (params.type !== "config") return new Response("Not found", { status: 404 });
  const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain } }).catch(() => null);
  return Response.json(
    { dataLayer: effectiveDataLayerConfig(settings) },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.public.appProxy(request);
  const shopDomain = session?.shop;
  if (!shopDomain) return new Response("Unauthorized", { status: 401 });
  if (params.type !== "track") return new Response("Not found", { status: 404 });

  const clientIp = clientIpFromRequest(request);
  // Abuse guard (same limiter as /pixel/track). This path is app-proxy-signed, so it's lower risk, but
  // a compromised/looping embed shouldn't be able to flood a shop's server-side sends either.
  const rl = checkIngestRate(shopDomain, clientIp);
  if (!rl.ok) return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const body = await request.json().catch(() => null);
  // Best-effort, like /pixel/track: a post-delivery DB hiccup must not turn a successful send into a
  // 500 (Shopify would retry the proxy call → a duplicate fan-out). Always ack with 204.
  await ingestEvent(shopDomain, body, clientIp).catch(() => {});
  return new Response(null, { status: 204 });
};
