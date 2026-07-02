import { ingestEvent } from "../lib/ingest.server";
import { verifyPixelToken } from "../lib/pixel-token.server";

// Direct cross-origin ingest endpoint for the Web Pixel. The strict pixel sandbox blocks requests to
// the shop's own origin (RestrictedUrlError), so it CANNOT use the app proxy — it beacons here on the
// app's own host instead. There's no app-proxy signature, so the shop is read from the payload and
// validated against installed settings inside ingestEvent (unknown shops are ignored). sendBeacon
// sends text/plain (a "simple" request) so no CORS preflight is needed; headers are set for safety.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export const loader = () => new Response(null, { status: 204, headers: CORS });

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const body = await request.json().catch(() => null);
  const shopDomain = typeof body?.shop === "string" ? body.shop : null;
  // Reject forged beacons: the shop-scoped token is baked into the pixel config and checked here so a
  // caller can't fabricate events for an arbitrary shop from its domain alone. Silent 204 (don't leak
  // which shops are installed, and never make a bad beacon retry).
  if (!shopDomain || !verifyPixelToken(shopDomain, body?.token)) {
    return new Response(null, { status: 204, headers: CORS });
  }
  const clientIp = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || undefined;
  await ingestEvent(shopDomain, body, clientIp).catch(() => {});
  return new Response(null, { status: 204, headers: CORS });
};
