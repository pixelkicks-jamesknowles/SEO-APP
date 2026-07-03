// Durable first-party visitor id — the app's answer to ITP/ETP cookie truncation.
//
// The problem: Safari's ITP caps every JS-set cookie (document.cookie) at 7 days, and clears more
// aggressively on repeat visits, so _ga / _shopify_y die fast. A conversion in a later session then
// looks like a brand-new user — wrecking cross-session attribution and match quality.
//
// The fix: mint a UUID and set it as a first-party cookie via a Set-Cookie RESPONSE HEADER from the app
// PROXY (which is same-origin to the storefront). Server-set first-party cookies are NOT subject to
// ITP's 7-day script-cookie cap, so this id survives where _ga doesn't — the same technique Elevar /
// Stape / Aimerce call a "durable id" or "cookie-lifespan extension".
//
// It's readable (not HttpOnly) on purpose: the strict Web Pixel sandbox reads it with
// browser.cookie.get("pxp_id") — the same way it already reads _ga / _shopify_y — so both the
// first-party embed path AND the cross-origin pixel path can carry the same stable id. The value is an
// anonymous UUID (no PII), so a readable cookie is an acceptable trade for that reach.
//
// Minting REQUIRES the first-party app proxy (the SEO-engagement theme embed calls /apps/<proxy>/id on
// load); the cross-origin /pixel/track beacon can't set a first-party cookie, so without the embed the
// durable id is simply absent and the existing _ga/_shopify_y fallbacks apply.
import crypto from "node:crypto";

export const DURABLE_COOKIE = "pxp_id";
// 400 days = Chrome's max cookie lifetime. Re-set on every mint/read so an active visitor's window
// slides forward (a returning visitor never ages out).
const MAX_AGE_SEC = 400 * 24 * 60 * 60;

/** Read the durable id from a request's Cookie header, or null. Pure. */
export function readDurableId(request) {
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)pxp_id=([^;]+)/);
  if (!m) return null;
  try {
    const v = decodeURIComponent(m[1]);
    return isValidDurableId(v) ? v : null;
  } catch {
    return null;
  }
}

/** A fresh durable id (UUID v4). */
export function mintDurableId() {
  return crypto.randomUUID();
}

/** Accept only a plausible id (UUID-ish) so a junk/oversized cookie can't be replayed as an identifier. */
export function isValidDurableId(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** The Set-Cookie header value for a durable id: first-party, Secure, Lax, long-lived. NOT HttpOnly (the
 *  pixel sandbox must be able to read it). Server-set → not capped by ITP's 7-day script-cookie rule. */
export function durableCookie(id) {
  return `${DURABLE_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${MAX_AGE_SEC}; SameSite=Lax; Secure`;
}

/** Resolve the durable id for a first-party (app-proxy) request: reuse the cookie if present + valid,
 *  else mint one. Returns { id, setCookie } — always re-set to slide the expiry forward. */
export function resolveDurableId(request) {
  const existing = readDurableId(request);
  const id = existing || mintDurableId();
  return { id, setCookie: durableCookie(id) };
}
