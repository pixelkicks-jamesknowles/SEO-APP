import { register } from "@shopify/web-pixels-extension";

// Shopify standard customer events we can route (must match app/routes/app.tracking.jsx).
const EVENTS = [
  "page_viewed",
  "product_viewed",
  "collection_viewed",
  "search_submitted",
  "product_added_to_cart",
  "checkout_started",
  "payment_info_submitted",
  "checkout_completed",
];
const PLATFORMS = ["gtm", "ga4", "meta"];
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

const safeParse = (s) => {
  try {
    return JSON.parse(s || "");
  } catch {
    return null;
  }
};

const utmFromHref = (href) => {
  try {
    const u = new URL(href);
    const out = {};
    for (const k of UTM_KEYS) {
      const v = u.searchParams.get(k);
      if (v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
};

// Google Ads click identifiers from the URL (gclid / gbraid / wbraid) — feed Enhanced Conversions.
const clickIdsFromHref = (href) => {
  try {
    const u = new URL(href);
    const out = {};
    for (const k of ["gclid", "gbraid", "wbraid"]) {
      const v = u.searchParams.get(k);
      if (v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
};

// GA4 client_id from a `_ga` cookie value (GA1.1.<id>.<ts> → "<id>.<ts>"), so server-side events
// stitch to the same GA4 user/session the on-page gtag created.
const gaClientId = (gaCookie) => {
  if (typeof gaCookie !== "string") return null;
  const parts = gaCookie.split(".");
  if (parts.length < 4) return null;
  return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
};

// GA4 session_id from a `_ga_<container>` cookie value ("GS1.1.<session_id>.<n>…" → "<session_id>"),
// so server-side events attribute to the same GA4 session gtag created (GA4 MP best practice).
const gaSessionId = (cookie) => {
  if (typeof cookie !== "string") return null;
  const parts = cookie.split(".");
  return parts.length >= 3 && /^\d+$/.test(parts[2]) ? parts[2] : null;
};

// Stable numeric hash (for deriving a GA4 session_id from Shopify's session cookie).
const hashNum = (s) => {
  if (typeof s !== "string" || !s) return null;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(h);
};

register(({ analytics, browser, settings, init }) => {
  // All config travels in one JSON field (settings.config) — Shopify requires every declared
  // web-pixel field to be non-blank, so per-platform fields can't be left empty.
  const s = safeParse(settings.config) || {};
  const cfg = {
    ids: { gtm: s.gtmId || null, ga4: s.ga4Id || null, meta: s.metaPixelId || null },
    matrix: s.eventMatrix && typeof s.eventMatrix === "object" ? s.eventMatrix : {},
    consentMode: s.consentMode !== false,
    // Consent Mode v2: when true, still send consent-FLAGGED events without consent (GA4 models the
    // gap; Meta is skipped server-side) instead of suppressing them. When false, strict gate.
    consentSignals: s.consentSignals !== false,
    // Absolute cross-origin URL on the app's OWN host. The strict pixel sandbox blocks requests to the
    // shop's origin (RestrictedUrlError), so we cannot beacon to an app proxy on the shop domain -
    // we send here directly. shopDomain travels in the body (a direct request has no proxy signature).
    // Both written by the app on save (webPixelCreate/Update).
    trackUrl: s.trackUrl || null,
    shop: s.shopDomain || null,
    // Shop-scoped token the server checks so forged beacons for other shops are rejected.
    token: s.trackToken || null,
    debug: s.debug === true,
  };

  // Logged-in customer identifiers (if any) — captured up front so even pre-checkout events
  // (ViewContent / AddToCart) carry an em/external_id and match better in Meta.
  const customer = init?.data?.customer || null;

  // Current Customer-Privacy consent state, or null if the API isn't available.
  const consentState = () => {
    const c = init?.customerPrivacy;
    if (!c) return null;
    return { analytics: Boolean(c.analyticsProcessingAllowed), marketing: Boolean(c.marketingAllowed) };
  };

  // Which platforms (with an id) opted into this event in the matrix.
  const platformsFor = (name) =>
    PLATFORMS.filter((p) => cfg.ids[p] && (cfg.matrix[p] || []).includes(name));

  const route = async (name, event) => {
    const wanted = platformsFor(name);
    const consent = consentState();
    // Split consent (Consent Mode v2): ANALYTICS consent gates GA4/GTM (a normal, cookie'd analytics
    // hit); MARKETING consent separately gates Meta, the ad-personalisation signals and any PII.
    // Requiring both before sending anything would withhold GA4 traffic from the very common
    // "accept analytics, decline marketing" visitor — they'd never show as users in GA4.
    const analyticsOk = !cfg.consentMode || Boolean(consent && consent.analytics);
    const marketingOk = !cfg.consentMode || Boolean(consent && consent.marketing);

    const payload = {
      name,
      id: event?.id,
      timestamp: event?.timestamp,
      data: event?.data,
      context: event?.context,
      utm: utmFromHref(event?.context?.document?.location?.href),
      userAgent: event?.context?.navigator?.userAgent || null,
    };
    // Record consent state so the server flags GA4/GTM hits (ad_user_data / ad_personalization) and
    // skips Meta without marketing consent.
    if (cfg.consentMode) payload.consent = consent || { analytics: false, marketing: false };

    // Debug mode: log every event in the storefront console regardless of platform IDs / consent,
    // so firing can be verified without configuring any destination tag.
    if (cfg.debug) {
      try {
        // eslint-disable-next-line no-console
        console.log("[pixelify-tracking]", name, { analyticsOk, marketingOk, platforms: wanted, payload });
      } catch {
        /* sandbox: never throw */
      }
    }

    if (!wanted.length) return;

    if (!analyticsOk) {
      // Analytics declined. Strict gate → suppress. Consent Mode v2 → send a flagged, PII-free hit
      // (no identifiers) so GA4 can model the gap. Meta is skipped server-side regardless.
      if (!(cfg.consentMode && cfg.consentSignals)) return;
      dispatch(event, payload, wanted);
      return;
    }

    // Analytics granted → attach the analytics identifiers so the visitor is ONE GA4 user/session.
    try {
      const ga4Suffix = (cfg.ids.ga4 || "").replace(/^G-/, "");
      const [ga, gaSession, shopifyY, shopifyS] = await Promise.all([
        browser.cookie.get("_ga"),
        ga4Suffix ? browser.cookie.get(`_ga_${ga4Suffix}`) : Promise.resolve(null),
        browser.cookie.get("_shopify_y"),
        browser.cookie.get("_shopify_s"),
      ]);
      // client_id: GA's own (stitches to gtag if present), else Shopify's persistent visitor id so a
      // visitor is ONE user. Without a fallback the server derives a per-EVENT id and every event counts
      // as a new user/session in GA4 (there's no _ga cookie on a server-side-only storefront).
      payload.clientId = gaClientId(ga) || shopifyY || null;
      // session_id: GA's if present, else a stable number from Shopify's per-session cookie.
      const sid = gaSessionId(gaSession) || hashNum(shopifyS);
      if (sid) payload.sessionId = sid;
      // Marketing identifiers only with marketing consent — they feed Meta / Google Ads matching.
      if (marketingOk) {
        const [fbp, fbc] = await Promise.all([browser.cookie.get("_fbp"), browser.cookie.get("_fbc")]);
        if (fbp) payload.fbp = fbp;
        if (fbc) payload.fbc = fbc;
        // Google Ads click ids from the landing URL (Enhanced Conversions match key).
        const clickIds = clickIdsFromHref(event?.context?.document?.location?.href);
        if (Object.keys(clickIds).length) payload.clickIds = clickIds;
      }
    } catch {
      /* cookies unavailable — server falls back to a stable synthetic client_id */
    }
    // Logged-in customer PII feeds Meta match quality → marketing consent only.
    if (marketingOk && customer) {
      if (customer.id) payload.externalId = String(customer.id);
      if (customer.email) payload.email = customer.email;
      if (customer.phone) payload.phone = customer.phone;
    }

    dispatch(event, payload, wanted);
  };

  // One signed beacon to the app proxy carrying the full normalized event. The server (proxy.$type
  // → fanOutServerSide) builds and POSTs the real GA4 MP / Meta CAPI / sGTM payloads using the
  // stored credentials. In the strict sandbox you can't inject gtag/fbq, so server-side IS the path.
  const dbg = (...args) => {
    if (!cfg.debug) return;
    try {
      // eslint-disable-next-line no-console
      console.log("[pixelify-tracking]", ...args);
    } catch {
      /* sandbox: never throw */
    }
  };
  const dispatch = (event, payload, platforms) => {
    const url = cfg.trackUrl;
    dbg("beacon →", url || "(no trackUrl — re-save the Tracking page)", { platforms });
    if (!url) return; // not configured yet (e.g. pre-deploy / pre-save)
    try {
      // Cross-origin beacon to the app host (the sandbox allows this; same-origin is blocked). Shopify's
      // sandbox browser.sendBeacon resolves a Promise<boolean>; surface success/failure in debug.
      const r = browser.sendBeacon(url, JSON.stringify({ shop: cfg.shop, token: cfg.token, platforms, event: payload }));
      if (r && typeof r.then === "function") {
        r.then((ok) => dbg("beacon result", ok)).catch((e) => dbg("beacon rejected", e && e.message));
      }
    } catch (e) {
      dbg("beacon threw", e && e.message);
    }
  };

  for (const e of EVENTS) {
    analytics.subscribe(e, (event) => {
      route(e, event).catch(() => {});
    });
  }
});
