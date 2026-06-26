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

register(({ analytics, browser, settings, init }) => {
  // All config travels in one JSON field (settings.config) — Shopify requires every declared
  // web-pixel field to be non-blank, so per-platform fields can't be left empty.
  const s = safeParse(settings.config) || {};
  const cfg = {
    ids: { gtm: s.gtmId || null, ga4: s.ga4Id || null, meta: s.metaPixelId || null },
    matrix: s.eventMatrix && typeof s.eventMatrix === "object" ? s.eventMatrix : {},
    consentMode: s.consentMode !== false,
    // App-proxy path (e.g. "/apps/pixelify-seo/track"). Resolved against the storefront origin at
    // send time so it works on custom domains. The app writes this on save (webPixelCreate/Update).
    proxyPath: s.proxyPath || s.proxyUrl || null,
    debug: s.debug === true,
  };

  // Consent gate. With consentMode on, fire nothing until the visitor has allowed
  // analytics + marketing processing (Customer Privacy API).
  const consentAllows = () => {
    if (!cfg.consentMode) return true;
    const c = init?.customerPrivacy;
    if (!c) return false;
    return Boolean(c.analyticsProcessingAllowed && c.marketingAllowed);
  };

  // Which platforms (with an id) opted into this event in the matrix.
  const platformsFor = (name) =>
    PLATFORMS.filter((p) => cfg.ids[p] && (cfg.matrix[p] || []).includes(name));

  // Absolute app-proxy URL from the event's storefront origin + the configured proxy path.
  const proxyUrlFor = (event) => {
    if (!cfg.proxyPath) return null;
    if (cfg.proxyPath.startsWith("http")) return cfg.proxyPath; // pre-absolutized
    const loc = event?.context?.document?.location;
    let origin = loc?.origin;
    if (!origin && loc?.href) {
      try {
        origin = new URL(loc.href).origin;
      } catch {
        origin = null;
      }
    }
    return origin ? `${origin}${cfg.proxyPath}` : null;
  };

  const route = async (name, event) => {
    const wanted = platformsFor(name);
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
        console.log("[pixelify-tracking]", name, { consentAllowed: consentAllows(), platforms: wanted, payload });
      } catch {
        /* sandbox: never throw */
      }
    }

    if (!consentAllows()) return;
    if (!wanted.length) return;

    // Enrich with the identifiers the server-side payloads need (GA4 client_id, Meta fbp/fbc).
    try {
      const [ga, fbp, fbc] = await Promise.all([
        browser.cookie.get("_ga"),
        browser.cookie.get("_fbp"),
        browser.cookie.get("_fbc"),
      ]);
      payload.clientId = gaClientId(ga);
      if (fbp) payload.fbp = fbp;
      if (fbc) payload.fbc = fbc;
    } catch {
      /* cookies unavailable — server falls back to a stable synthetic client_id */
    }

    dispatch(event, payload, wanted);
  };

  // One signed beacon to the app proxy carrying the full normalized event. The server (proxy.$type
  // → fanOutServerSide) builds and POSTs the real GA4 MP / Meta CAPI / sGTM payloads using the
  // stored credentials. In the strict sandbox you can't inject gtag/fbq, so server-side IS the path.
  const dispatch = (event, payload, platforms) => {
    const url = proxyUrlFor(event);
    if (!url) return; // app proxy not configured yet (e.g. pre-deploy)
    try {
      browser.sendBeacon(url, JSON.stringify({ platforms, event: payload }));
    } catch {
      /* best-effort; never throw inside the sandbox */
    }
  };

  for (const e of EVENTS) {
    analytics.subscribe(e, (event) => {
      route(e, event).catch(() => {});
    });
  }
});
