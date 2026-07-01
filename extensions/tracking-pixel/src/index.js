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
    const granted = !cfg.consentMode || Boolean(consent && consent.analytics && consent.marketing);

    const payload = {
      name,
      id: event?.id,
      timestamp: event?.timestamp,
      data: event?.data,
      context: event?.context,
      utm: utmFromHref(event?.context?.document?.location?.href),
      userAgent: event?.context?.navigator?.userAgent || null,
    };

    // Debug mode: log every event in the storefront console regardless of platform IDs / consent,
    // so firing can be verified without configuring any destination tag.
    if (cfg.debug) {
      try {
        // eslint-disable-next-line no-console
        console.log("[pixelify-tracking]", name, { consentGranted: granted, platforms: wanted, payload });
      } catch {
        /* sandbox: never throw */
      }
    }

    if (!wanted.length) return;

    if (!granted) {
      // No consent. Strict gate → suppress. Consent Mode v2 → send a flagged, PII-free hit so GA4
      // can model the gap (Meta is skipped server-side without marketing consent).
      if (!(cfg.consentMode && cfg.consentSignals)) return;
      payload.consent = consent || { analytics: false, marketing: false };
      dispatch(event, payload, wanted);
      return;
    }

    // Consent granted (or consentMode off): attach every identifier we can for match quality.
    if (cfg.consentMode) payload.consent = consent || { analytics: true, marketing: true };
    try {
      const ga4Suffix = (cfg.ids.ga4 || "").replace(/^G-/, "");
      const [ga, gaSession, fbp, fbc] = await Promise.all([
        browser.cookie.get("_ga"),
        ga4Suffix ? browser.cookie.get(`_ga_${ga4Suffix}`) : Promise.resolve(null),
        browser.cookie.get("_fbp"),
        browser.cookie.get("_fbc"),
      ]);
      payload.clientId = gaClientId(ga);
      const sid = gaSessionId(gaSession);
      if (sid) payload.sessionId = sid;
      if (fbp) payload.fbp = fbp;
      if (fbc) payload.fbc = fbc;
    } catch {
      /* cookies unavailable — server falls back to a stable synthetic client_id */
    }
    if (customer) {
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
      const r = browser.sendBeacon(url, JSON.stringify({ shop: cfg.shop, platforms, event: payload }));
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
