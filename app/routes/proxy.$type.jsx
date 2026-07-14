// NOTE: use Remix's `json()` helper, NOT the static `Response.json()`. remix-serve swaps in the
// @remix-run/web-fetch polyfill, which has no static Response.json — calling it throws
// "TypeError: Response.json is not a function" at runtime (a 500 in production that never shows up in
// dev or tests). See tests/no-response-json.test.js, which guards against this regressing.
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ingestEvent } from "../lib/ingest.server";
import { checkIngestRate, clientIpFromRequest } from "../lib/ratelimit.server";
import { effectiveDataLayerConfig } from "../lib/datalayer";
import { resolveDurableId, readDurableId } from "../lib/durable-id.server";

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
  // GET /apps/<proxy>/id: mint (or refresh) the durable first-party visitor cookie. Server-set from this
  // same-origin proxy so it survives ITP's 7-day script-cookie cap. The SEO-engagement embed calls this
  // on load; the pixel then reads the same cookie. Never cached (each response re-sets the sliding expiry).
  if (params.type === "id") {
    const { id, setCookie } = resolveDurableId(request);
    return json({ id }, { headers: { "Cache-Control": "no-store", "Set-Cookie": setCookie } });
  }
  if (params.type !== "config") return new Response("Not found", { status: 404 });
  const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain } }).catch(() => null);
  return json(
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
  // Durable id: this is a first-party same-origin request, so the pxp_id cookie rides along. Read it
  // server-side (authoritative — not spoofable from the body) and stamp it on the event so embed-sourced
  // events carry the same stable id the pixel reads from the cookie.
  const durableId = readDurableId(request);
  if (durableId && body?.event) body.event.durableId = durableId;
  // Best-effort, like /pixel/track: a post-delivery DB hiccup must not turn a successful send into a
  // 500 (Shopify would retry the proxy call → a duplicate fan-out). Always ack with 204.
  await ingestEvent(shopDomain, body, clientIp).catch(() => {});
  return new Response(null, { status: 204 });
};
