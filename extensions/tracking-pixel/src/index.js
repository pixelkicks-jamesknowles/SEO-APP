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

register(({ analytics, browser, settings, init }) => {
  const cfg = {
    ids: {
      gtm: settings.gtmId || null,
      ga4: settings.ga4Id || null,
      meta: settings.metaPixelId || null,
    },
    matrix: safeParse(settings.eventMatrix) || {},
    consentMode: settings.consentMode !== "false",
    proxyUrl: settings.proxyUrl || null,
  };

  // Consent gate. With consentMode on, fire nothing until the visitor has allowed
  // analytics + marketing processing (Customer Privacy API).
  const consentAllows = () => {
    if (!cfg.consentMode) return true;
    const c = init?.customerPrivacy;
    if (!c) return false;
    return Boolean(c.analyticsProcessingAllowed && c.marketingAllowed);
  };

  // Route one normalized event to each platform that (a) has an ID and (b) opted in
  // to this event in the matrix.
  const route = (name, event) => {
    if (!consentAllows()) return;
    const payload = {
      name,
      id: event?.id,
      timestamp: event?.timestamp,
      data: event?.data,
      context: event?.context,
      utm: utmFromHref(event?.context?.document?.location?.href),
    };
    for (const p of PLATFORMS) {
      if (!cfg.ids[p]) continue;
      if (!(cfg.matrix[p] || []).includes(name)) continue;
      dispatch(p, name, payload);
    }
  };

  // Per-platform transport. In the strict sandbox you can't drop gtag/fbq <script> tags,
  // so the reliable path is server-side: beacon the normalized event to the app proxy,
  // which fans out to GA4 Measurement Protocol / Meta CAPI / server-side GTM with the
  // stored credentials. Client-side (lax) transports per platform are a follow-up.
  const dispatch = (platform, name, payload) => {
    if (cfg.proxyUrl) {
      const body = JSON.stringify({ platform, id: cfg.ids[platform], event: payload });
      try {
        browser.sendBeacon(cfg.proxyUrl, body);
      } catch {
        // best-effort; never throw inside the sandbox
      }
      return;
    }
    // TODO(client-side): per-platform gtag/fbq/ttq transports for non-server-side mode.
  };

  for (const e of EVENTS) {
    analytics.subscribe(e, (event) => route(e, event));
  }
});
