// SSRF guard for merchant-supplied outbound URLs (the sGTM container URL, and any future webhook URL).
// The server POSTs live GA4/Meta payloads to these, so an unvalidated value lets an admin point us at
// cloud metadata (169.254.169.254), localhost, or an internal service. We require HTTPS and reject any
// host that is an IP literal in a private/loopback/link-local range or an obvious internal name.
//
// This is a static, allow-by-shape check (no DNS resolution), so it does NOT defend against DNS
// rebinding — but it closes the trivial "paste an internal URL" case, which is the realistic risk for an
// authenticated-admin-only field. Returns { ok } or { ok:false, reason }.

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (PRIVATE_V4.test(h)) return true;
  // IPv6 loopback / link-local / unique-local.
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254).
  const mapped = h.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)/i);
  if (mapped && PRIVATE_V4.test(mapped[1])) return true;
  return false;
}

// Default outbound-request deadline. Every server-side send goes through fetchWithTimeout so a hung or
// slow-loris destination can't hold a request open indefinitely — which matters most in the SEQUENTIAL
// outbox drain, where one stalled send would otherwise freeze the whole cron tick. Kept well under the
// 5-minute outbox lease so a send can never outlive its lease and get re-selected + re-sent.
export const DEFAULT_TIMEOUT_MS = 10_000;

/** fetch() with an AbortController deadline. On timeout the abort makes fetch reject; callers already
 *  treat a throw as a retryable failure (best-effort { ok:false }). Returns the Response on success. */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** True (with reason on failure) if a URL is safe to POST to from the server. HTTPS-only, public host. */
export function isSafePublicHttpsUrl(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "must be https://" };
  if (!u.hostname) return { ok: false, reason: "missing host" };
  if (isPrivateHost(u.hostname)) return { ok: false, reason: "points at a private, loopback or internal address" };
  return { ok: true };
}
