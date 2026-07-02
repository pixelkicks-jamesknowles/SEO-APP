// Shop-scoped token for the unsigned /pixel/track beacon.
//
// The Web Pixel's strict sandbox blocks the same-origin app proxy, so it beacons cross-origin to
// /pixel/track with the shop in the body — there's no Shopify app-proxy HMAC on that path. Without a
// check, anyone could POST fabricated events naming any installed shop and have them fanned out to
// that shop's real GA4/Meta credentials as conversions.
//
// This token is a deterministic HMAC of the shop domain keyed on the app secret. It's baked into the
// pixel config (so it IS visible to anyone who inspects that shop's storefront) — it does NOT make the
// endpoint truly authenticated. What it buys: an attacker can no longer forge events for an ARBITRARY
// shop from its domain alone; they'd have to first scrape each target shop's pixel config. That raises
// blind/mass forgery from trivial to per-target, which is the best a client-exposed beacon can do.
import crypto from "node:crypto";

const secret = () => process.env.SHOPIFY_API_SECRET || "";

/** Deterministic per-shop token: base64url(HMAC-SHA256(appSecret, shopDomain)), truncated. */
export function pixelToken(shopDomain) {
  if (!shopDomain || !secret()) return null;
  return crypto.createHmac("sha256", secret()).update(String(shopDomain)).digest("base64url").slice(0, 32);
}

/** Constant-time compare of a presented token against the expected one for a shop. */
export function verifyPixelToken(shopDomain, presented) {
  const expected = pixelToken(shopDomain);
  if (!expected || typeof presented !== "string" || presented.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  } catch {
    return false;
  }
}
