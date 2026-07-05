// Google Ads Enhanced Conversions (direct upload via the Google Ads API). GATED: fully inert unless
// the GOOGLE_ADS_DEVELOPER_TOKEN + GOOGLE_OAUTH_CLIENT_ID/SECRET env vars are set AND the merchant has
// connected (OAuth) and configured a customer + conversion action. When active, a purchase fans out an
// extra "google_ads" job (built in the buildJobs hook) that uploadClickConversions delivers, matching
// on the gclid captured on-page and/or hashed customer identifiers (Enhanced Conversions).
//
// The pure builder (buildClickConversion) has no IO and is unit-tested. Network + token IO lives in
// deliverGoogleAds / the OAuth helpers. Tokens are encrypted at rest (secrets.server), like the other
// server-side credentials.
import crypto from "node:crypto";
import prisma from "../db.server";
import { sha256Hex, normalizePhoneE164 } from "./server-side.server";
import { encryptSecret, decryptSecret } from "./secrets.server";
import { fetchWithTimeout } from "./net.server";

const GADS_VERSION = "v18";
const OAUTH_SCOPE = "https://www.googleapis.com/auth/adwords";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Env-level gate: the app operator must supply a Google Ads developer token + OAuth client. */
export function googleAdsEnvReady() {
  return Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function googleAdsConfigOf(settings) {
  try {
    return JSON.parse(settings?.googleAdsConfig || "{}");
  } catch {
    return {};
  }
}

/** Fully ready to deliver: env configured + merchant enabled + a customer & conversion action set. */
export function googleAdsReady(settings) {
  if (!googleAdsEnvReady() || !settings?.googleAdsEnabled) return false;
  const c = googleAdsConfigOf(settings);
  return Boolean(c.customerId && c.conversionActionId);
}

/** Whether a merchant has connected their Google account (an OAuth refresh token is stored). */
export async function googleAdsConnected(shopDomain) {
  const row = await prisma.googleToken.findUnique({ where: { shopDomain } }).catch(() => null);
  return Boolean(row?.refreshToken);
}

/** Pull the Google-Ads matchable identifiers off a normalized pixel event. */
export function googleAdsIdentifiers(event) {
  const ci = event?.clickIds || {};
  const checkout = event?.data?.checkout || {};
  return {
    gclid: ci.gclid || event?.gclid || null,
    gbraid: ci.gbraid || null,
    wbraid: ci.wbraid || null,
    email: event?.email || checkout?.email || null,
    phone: event?.phone || checkout?.phone || null,
  };
}

/** "yyyy-mm-dd HH:MM:SS+00:00" (UTC) — the format the Google Ads API requires for conversionDateTime. */
export function formatGoogleDateTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return safe.toISOString().slice(0, 19).replace("T", " ") + "+00:00";
}

/** Build a Google Ads ClickConversion (pure). Prefers gclid/gbraid/wbraid; adds hashed Enhanced-
 *  Conversion user identifiers (email / phone) when present. Returns null without any match key. */
export function buildClickConversion(config, d = {}) {
  const hasClickId = d.gclid || d.gbraid || d.wbraid;
  const em = sha256Hex(d.email);
  // Google Ads Enhanced Conversions require E.164 (with the leading "+") before hashing — a digits-only
  // hash never matches Google's, so a phone-only conversion would be silently unattributable.
  const phE164 = normalizePhoneE164(d.phone);
  const ph = phE164 ? sha256Hex(phE164) : null;
  if (!hasClickId && !em && !ph) return null; // nothing to match on → skip

  const conv = {
    conversionAction: `customers/${config.customerId}/conversionActions/${config.conversionActionId}`,
    conversionDateTime: formatGoogleDateTime(d.timestamp),
    conversionValue: Number(d.value) || 0,
    currencyCode: d.currency || "USD",
  };
  if (d.transactionId) conv.orderId = String(d.transactionId);
  if (d.gclid) conv.gclid = d.gclid;
  else if (d.gbraid) conv.gbraid = d.gbraid;
  else if (d.wbraid) conv.wbraid = d.wbraid;
  const userIdentifiers = [];
  if (em) userIdentifiers.push({ hashedEmail: em });
  if (ph) userIdentifiers.push({ hashedPhoneNumber: ph });
  if (userIdentifiers.length) conv.userIdentifiers = userIdentifiers;
  return conv;
}

/** buildJobs hook: on a purchase with a matchable identifier, contribute a "google_ads" job carrying
 *  the built ClickConversion (uses the already-normalized GA4 value/currency for consistency). */
export function googleAdsHook(settings) {
  if (!googleAdsReady(settings)) return {};
  const config = googleAdsConfigOf(settings);
  return {
    extraJobs: (event, ga4Event, ctx) => {
      if (!ctx?.isPurchaseConv) return [];
      // Enhanced Conversions carry hashed PII (email/phone), so — like Meta/TikTok/etc. — they need
      // marketing consent. Unknown consent is treated as granted (mirrors buildJobs). Without this gate a
      // consent-declining visitor's hashed PII would still reach Google Ads on both the live and the
      // reconcile-backfill paths.
      const marketingOk = !ctx?.consent || ctx.consent.marketing;
      if (!marketingOk) return [];
      const ids = googleAdsIdentifiers(event);
      const conversion = buildClickConversion(config, {
        value: ga4Event?.params?.value,
        currency: ga4Event?.params?.currency,
        transactionId: ga4Event?.params?.transaction_id,
        timestamp: event?.timestamp,
        ...ids,
      });
      if (!conversion) return [];
      return [{ destination: "google_ads", eventName: event.name, event: conversion }];
    },
  };
}

// ---- OAuth + delivery IO ----

/** The OAuth redirect URI (must be registered in the Google Cloud console). */
export function googleRedirectUri() {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  return `${base}/google/oauth/callback`;
}

// A signed OAuth `state` carries the shop AND a single-use nonce, HMAC'd on the app secret. The HMAC
// stops an attacker forging a state for an arbitrary shop; the nonce (persisted server-side, cleared
// on use — see createOAuthState/consumeOAuthState) makes the state unpredictable and non-replayable,
// closing the login-CSRF hole a deterministic shop-only state would leave open.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the Google consent screen

function stateSig(shop, nonce) {
  return crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET || "").update(`${shop}.${nonce}`).digest("base64url").slice(0, 32);
}

/** Sign (shop, nonce) into an OAuth `state`. Pure — persistence is done by createOAuthState. */
export function signState(shop, nonce) {
  return `${Buffer.from(shop).toString("base64url")}.${Buffer.from(String(nonce)).toString("base64url")}.${stateSig(shop, nonce)}`;
}

/** Verify a signed state's HMAC → { shop, nonce }, or null if tampered. Does NOT check the nonce
 *  against storage (that's consumeOAuthState) — this is the pure, DB-free half. */
export function verifyState(state) {
  const [b, n, sig] = String(state || "").split(".");
  if (!b || !n || !sig) return null;
  let shop, nonce;
  try {
    shop = Buffer.from(b, "base64url").toString("utf8");
    nonce = Buffer.from(n, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = stateSig(shop, nonce);
  try {
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? { shop, nonce } : null;
  } catch {
    return null;
  }
}

/** Begin a connect: mint a single-use nonce, persist it on the shop with a short TTL, and return the
 *  signed `state` for the consent URL. Overwrites any prior pending nonce (only the latest is valid). */
export async function createOAuthState(shopDomain) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const googleOauthNonceExpiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
  await prisma.shop.upsert({
    where: { shopDomain },
    create: { shopDomain, googleOauthNonce: nonce, googleOauthNonceExpiresAt },
    update: { googleOauthNonce: nonce, googleOauthNonceExpiresAt },
  });
  return signState(shopDomain, nonce);
}

/** Verify + consume a callback `state`: checks the HMAC, then that the nonce matches the one stored
 *  for the shop and hasn't expired, then clears it (single-use). Returns the shop domain or null.
 *  The nonce is always cleared once a valid-HMAC state is seen, so a state can't be replayed. */
export async function consumeOAuthState(state) {
  const parsed = verifyState(state);
  if (!parsed) return null;
  const { shop, nonce } = parsed;
  const row = await prisma.shop.findUnique({ where: { shopDomain: shop } }).catch(() => null);
  if (!row?.googleOauthNonce || !row.googleOauthNonceExpiresAt) return null;
  // Single-use: clear the stored nonce now, before validating, so the same state can't be replayed
  // (only a caller holding the app secret can reach here, so clearing on mismatch isn't a DoS vector).
  await prisma.shop.update({ where: { shopDomain: shop }, data: { googleOauthNonce: null, googleOauthNonceExpiresAt: null } }).catch(() => {});
  if (row.googleOauthNonceExpiresAt.getTime() < Date.now()) return null;
  const a = Buffer.from(row.googleOauthNonce);
  const b = Buffer.from(nonce);
  try {
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? shop : null;
  } catch {
    return null;
  }
}

/** The consent URL to start connecting a merchant's Google account. `state` carries the signed shop. */
export function googleAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body) {
  const res = await fetchWithTimeout(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error_description || json?.error || `token HTTP ${res.status}`);
  return json;
}

/** Exchange an OAuth code for tokens and store them (encrypted) for the shop. */
export async function exchangeAndStore(shopDomain, code, redirectUri) {
  const t = await tokenRequest({
    code,
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const expiresAt = new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000);
  const data = {
    accessToken: encryptSecret(t.access_token || ""),
    refreshToken: t.refresh_token ? encryptSecret(t.refresh_token) : undefined,
    expiresAt,
  };
  await prisma.googleToken.upsert({
    where: { shopDomain },
    create: { shopDomain, accessToken: data.accessToken, refreshToken: data.refreshToken ?? null, expiresAt },
    update: data,
  });
}

/** Disconnect: drop the stored Google tokens for a shop. */
export async function googleAdsDisconnect(shopDomain) {
  await prisma.googleToken.deleteMany({ where: { shopDomain } }).catch(() => {});
}

// Valid (refreshed if needed) access token for a shop, or null if not connected.
async function getAccessToken(shopDomain) {
  const row = await prisma.googleToken.findUnique({ where: { shopDomain } }).catch(() => null);
  if (!row) return null;
  const access = decryptSecret(row.accessToken);
  if (access && row.expiresAt && row.expiresAt.getTime() > Date.now() + 60_000) return access;
  const refresh = decryptSecret(row.refreshToken || "");
  if (!refresh) return access || null;
  try {
    const t = await tokenRequest({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    });
    const expiresAt = new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000);
    await prisma.googleToken.update({ where: { shopDomain }, data: { accessToken: encryptSecret(t.access_token || ""), expiresAt } }).catch(() => {});
    return t.access_token;
  } catch {
    return access || null;
  }
}

/** Deliver one google_ads job (a built ClickConversion) via uploadClickConversions. Best-effort:
 *  returns { ok, detail } for the delivery-health log + outbox retry. */
export async function deliverGoogleAds(settings, job) {
  if (!googleAdsReady(settings)) return { ok: false, detail: "Google Ads not configured" };
  const config = googleAdsConfigOf(settings);
  const token = await getAccessToken(settings.shopDomain);
  if (!token) return { ok: false, detail: "Google account not connected" };
  const url = `https://googleads.googleapis.com/${GADS_VERSION}/customers/${config.customerId}:uploadClickConversions`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  if (config.loginCustomerId) headers["login-customer-id"] = String(config.loginCustomerId).replace(/\D/g, "");
  try {
    const res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify({ conversions: [job.event], partialFailure: true }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, detail: json?.error?.message || `HTTP ${res.status}` };
    if (json?.partialFailureError) return { ok: false, detail: json.partialFailureError.message || "partial failure" };
    return { ok: true, detail: "uploaded" };
  } catch (e) {
    return { ok: false, detail: e?.message || "network error" };
  }
}
