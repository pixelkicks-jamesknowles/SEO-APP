// In-memory rate limiter for the public storefront-ingest endpoints (/pixel/track, /apps/.../track).
//
// Why in-memory (not the DB): the whole point is to shed abusive load *before* it costs a DB write, so
// the limiter itself must not touch the DB. The app runs as a single Railway web process, so one
// per-process map is the whole fleet; if this ever scales to N replicas each replica enforces ~1/N of
// the limit, which is fine for an abuse guard (it's a ceiling, not an accounting system).
//
// Two independent ceilings per request, both fixed-window:
//   - per (shop + client IP): stops one browser/script from flooding a shop.
//   - per shop (all IPs): a spend ceiling so a distributed flood can't rack up unbounded DB writes /
//     ad-platform sends against one merchant's credentials even from many IPs.
// A request is limited if EITHER ceiling is exceeded. Legitimate storefront traffic (one pageview burst
// per visitor) sits far under these; the defaults are overridable via env for a high-traffic store.

const PER_IP_LIMIT = Number(process.env.RATE_LIMIT_PER_IP) || 120; // events / window / (shop+ip)
const PER_SHOP_LIMIT = Number(process.env.RATE_LIMIT_PER_SHOP) || 3000; // events / window / shop
const WINDOW_MS = (Number(process.env.RATE_LIMIT_WINDOW_SEC) || 60) * 1000;

// key -> { count, resetAt }. Swept lazily (below) so it can't grow without bound.
const buckets = new Map();
let lastSweep = 0;

function hit(key, limit, now) {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, remaining: limit - 1, resetAt: now + WINDOW_MS };
  }
  b.count += 1;
  return { ok: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt };
}

// Drop expired buckets occasionally (at most once per window) so an attacker rotating keys can't grow
// the map indefinitely. O(n) but bounded by how many distinct (shop,ip) pairs hit us in a window.
function sweep(now) {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

/**
 * Check + consume one unit of quota for a storefront ingest request. Returns { ok, retryAfter } where
 * retryAfter is seconds until the tighter window resets (for a 429 Retry-After header). Fails OPEN on a
 * missing shop (the caller already rejects those) so this never becomes a new way to drop good events.
 */
export function checkIngestRate(shopDomain, clientIp, { now = Date.now() } = {}) {
  if (!shopDomain) return { ok: true, retryAfter: 0 };
  sweep(now);
  const ip = clientIp || "noip";
  const perIp = hit(`${shopDomain}|${ip}`, PER_IP_LIMIT, now);
  const perShop = hit(`${shopDomain}|*`, PER_SHOP_LIMIT, now);
  const ok = perIp.ok && perShop.ok;
  const resetAt = Math.max(perIp.resetAt, perShop.resetAt);
  return { ok, retryAfter: ok ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)) };
}

// Test-only: reset the shared state between cases.
export function __resetRateLimiter() {
  buckets.clear();
  lastSweep = 0;
}

export const RATE_LIMITS = { PER_IP_LIMIT, PER_SHOP_LIMIT, WINDOW_MS };
