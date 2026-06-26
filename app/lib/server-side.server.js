// Server-side event fan-out from the app-proxy /track beacon. Builds COMPLETE GA4 Measurement
// Protocol + Meta Conversions API payloads (items, value, currency, transaction_id, dedup ids,
// hashed user data) and forwards to GA4, Meta CAPI and — when configured — a server-side GTM
// container. Best-effort: every send is fire-and-catch so a destination outage never breaks the
// storefront. Pure builders (extractCommerce / ga4EventFor / metaEventFor / parseGaClientId /
// sha256Hex / stableClientId) are exported and unit-tested without network IO.
import crypto from "node:crypto";

const META_API_VERSION = "v21.0";

// Shopify customer-event → GA4 recommended event name.
const GA4_MAP = {
  page_viewed: "page_view",
  product_viewed: "view_item",
  collection_viewed: "view_item_list",
  search_submitted: "search",
  product_added_to_cart: "add_to_cart",
  checkout_started: "begin_checkout",
  payment_info_submitted: "add_payment_info",
  checkout_completed: "purchase",
};

// Shopify customer-event → Meta standard event name.
const META_MAP = {
  page_viewed: "PageView",
  product_viewed: "ViewContent",
  collection_viewed: "ViewContent",
  search_submitted: "Search",
  product_added_to_cart: "AddToCart",
  checkout_started: "InitiateCheckout",
  payment_info_submitted: "AddPaymentInfo",
  checkout_completed: "Purchase",
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** SHA-256 hex of a normalized string (Meta requires lower-cased, trimmed, hashed PII). */
export function sha256Hex(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

/** GA4 client_id from a `_ga` cookie value, e.g. "GA1.1.1234567890.1700000000" → "1234567890.1700000000". */
export function parseGaClientId(gaCookie) {
  if (typeof gaCookie !== "string") return null;
  const parts = gaCookie.split(".");
  if (parts.length < 4 || !/^GA\d/.test(parts[0])) return null;
  return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

/** Deterministic GA4 client_id fallback from a stable event id — same event → same id (no Math.random). */
export function stableClientId(seed) {
  const s = String(seed ?? "0");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `${h}.0`;
}

// Normalize one Shopify "variant-ish" node (productVariant / merchandise / checkout lineItem.variant)
// into a GA4 item.
function toItem(v, quantity, fallbackName) {
  if (!v) return null;
  return {
    item_id: v.sku || v.product?.id || v.id || "",
    item_name: v.product?.title || fallbackName || v.title || "",
    item_variant: v.title || "",
    item_brand: v.product?.vendor || undefined,
    item_category: v.product?.type || undefined,
    price: num(v.price?.amount),
    quantity: Math.max(1, num(quantity) || 1),
  };
}

/**
 * Pull commerce facts out of a Shopify customer-event payload, regardless of event type.
 * Returns { currency, value, transactionId, items[] } — any field may be absent.
 */
export function extractCommerce(name, data) {
  const out = { currency: null, value: null, transactionId: null, items: [] };
  if (!data) return out;

  if (name === "product_viewed") {
    const it = toItem(data.productVariant, 1);
    if (it) {
      out.items = [it];
      out.value = it.price;
      out.currency = data.productVariant?.price?.currencyCode || null;
    }
  } else if (name === "product_added_to_cart") {
    const cl = data.cartLine;
    const it = toItem(cl?.merchandise, cl?.quantity);
    if (it) {
      out.items = [it];
      out.value = num(cl?.cost?.totalAmount?.amount) || it.price * it.quantity;
      out.currency = cl?.cost?.totalAmount?.currencyCode || cl?.merchandise?.price?.currencyCode || null;
    }
  } else if (name === "checkout_started" || name === "checkout_completed") {
    const co = data.checkout;
    out.items = (co?.lineItems || []).map((li) => toItem(li.variant, li.quantity, li.title)).filter(Boolean);
    out.value = num(co?.totalPrice?.amount);
    out.currency = co?.currencyCode || co?.totalPrice?.currencyCode || null;
    out.transactionId = co?.order?.id ? String(co.order.id) : co?.token || null;
  } else if (name === "collection_viewed") {
    out.items = (data.collection?.productVariants || []).map((v) => toItem(v, 1)).filter(Boolean);
  } else if (name === "search_submitted") {
    out.items = (data.searchResult?.productVariants || []).map((v) => toItem(v, 1)).filter(Boolean);
  }
  return out;
}

/** Build a GA4 Measurement Protocol event object { name, params } for a Shopify event. */
export function ga4EventFor(name, ev) {
  const c = extractCommerce(name, ev?.data);
  const params = { engagement_time_msec: 1 };
  const url = ev?.context?.document?.location?.href;
  if (url) params.page_location = url;
  if (c.currency) params.currency = c.currency;
  if (c.value != null) params.value = c.value;
  // transaction_id is GA4's purchase de-dup key — matching the native order id lets GA4 collapse
  // our server-side purchase with the Google & YouTube app's client-side one.
  if (name === "checkout_completed" && c.transactionId) params.transaction_id = c.transactionId;
  if (c.items.length) params.items = c.items;
  // Internal site search → a complete GA4 `search` event (search_term is what SEO teams report on).
  if (name === "search_submitted") {
    const q = ev?.data?.searchResult?.query;
    if (q) params.search_term = q;
  }
  for (const [k, utm] of Object.entries(ev?.utm || {})) params[k] = utm;
  // Synthetic theme events (scroll / engaged_view) carry their GA4 params directly.
  if (ev?.params && typeof ev.params === "object") Object.assign(params, ev.params);
  return { name: GA4_MAP[name] || name, params };
}

/** Build the hashed Meta user_data block from every identifier we can reach (drives Event Match Quality). */
export function metaUserData(ev) {
  const checkout = ev?.data?.checkout;
  const addr = checkout?.shippingAddress || checkout?.billingAddress || {};
  const user_data = {};
  // Cookies + network identifiers (unhashed, as Meta expects).
  if (ev?.fbp) user_data.fbp = ev.fbp;
  if (ev?.fbc) user_data.fbc = ev.fbc;
  if (ev?.clientIp) user_data.client_ip_address = ev.clientIp;
  if (ev?.userAgent) user_data.client_user_agent = ev.userAgent;
  // Hashed PII — checkout fields first, else identifiers captured earlier (logged-in customer).
  const put = (key, value) => {
    const h = sha256Hex(value);
    if (h) user_data[key] = [h];
  };
  put("em", checkout?.email || ev?.email);
  put("ph", (checkout?.phone || ev?.phone || "").replace(/\D/g, ""));
  put("fn", addr.firstName);
  put("ln", addr.lastName);
  put("ct", addr.city);
  put("st", addr.provinceCode || addr.province);
  put("zp", addr.zip);
  put("country", addr.countryCode || addr.country);
  // external_id (customer id) is not hashed by spec but commonly hashed for parity.
  if (ev?.externalId) user_data.external_id = [sha256Hex(String(ev.externalId))];
  return user_data;
}

/**
 * Build the GTM-style dataLayer push for an event — what an SEO/GTM team references when building
 * triggers/variables. Restructures the GA4 params into the standard `event` + `ecommerce` shape.
 * (We deliver server-side, but this is the canonical representation of the same data for GTM.)
 */
export function dataLayerFromGa4(ga4Event) {
  const params = { ...ga4Event.params };
  delete params.engagement_time_msec;
  const ecommerce = {};
  for (const k of ["currency", "value", "transaction_id", "items", "coupon", "tax", "shipping"]) {
    if (k in params) {
      ecommerce[k] = params[k];
      delete params[k];
    }
  }
  const push = { event: ga4Event.name, ...params };
  if (Object.keys(ecommerce).length) push.ecommerce = ecommerce;
  return push;
}

export function dataLayerFor(name, ev) {
  return dataLayerFromGa4(ga4EventFor(name, ev));
}

/** Build a Meta Conversions API event object for a Shopify event (incl. event_id for dedup). */
export function metaEventFor(name, ev) {
  const c = extractCommerce(name, ev?.data);
  const user_data = metaUserData(ev);

  const custom_data = {};
  if (c.currency) custom_data.currency = c.currency;
  if (c.value != null) custom_data.value = c.value;
  if (c.items.length) {
    custom_data.content_type = "product";
    custom_data.content_ids = c.items.map((i) => i.item_id);
    custom_data.contents = c.items.map((i) => ({ id: i.item_id, quantity: i.quantity, item_price: i.price }));
    custom_data.num_items = c.items.reduce((s, i) => s + i.quantity, 0);
  }
  if (name === "checkout_completed" && c.transactionId) custom_data.order_id = c.transactionId;

  return {
    event_name: META_MAP[name] || name,
    event_time: Math.floor((ev?.timestamp ? Date.parse(ev.timestamp) : Date.now()) / 1000),
    // event_id = the Shopify event id, so Meta de-dups this against any client-side pixel hit.
    event_id: ev?.id ? String(ev.id) : undefined,
    action_source: "website",
    event_source_url: ev?.context?.document?.location?.href || undefined,
    user_data,
    custom_data,
  };
}

async function postJson(url, body, headers = {}) {
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

// Google Consent Mode v2 signals for the GA4 MP `consent` block. marketing → ad signals,
// analytics → (GA4 storage is implied by sending; we flag the ad consent state Google needs to model).
export function ga4Consent(consent) {
  if (!consent) return undefined; // unknown (e.g. subscription webhook) → omit, treated as granted
  const g = (v) => (v ? "GRANTED" : "DENIED");
  return { ad_user_data: g(consent.marketing), ad_personalization: g(consent.marketing) };
}

async function sendGa4(measurementId, apiSecret, clientId, event, { endpoint, consent } = {}) {
  const base = endpoint || "https://www.google-analytics.com";
  const url = `${base.replace(/\/$/, "")}/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  const body = { client_id: clientId, events: [event] };
  const consentBlock = ga4Consent(consent);
  if (consentBlock) body.consent = consentBlock;
  await postJson(url, body);
}

async function sendMeta(pixelId, token, event) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;
  await postJson(url, { data: [event] });
}

// Server-side GTM: GTM-XXXX is a *web* container the strict pixel sandbox cannot load (no gtag.js),
// so the only server-side route is a sGTM container URL with a GA4 client — we POST the GA4 MP hit to it.
async function sendGtmServer(serverUrl, measurementId, apiSecret, clientId, event, consent) {
  const url = `${serverUrl.replace(/\/$/, "")}/g/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  const body = { client_id: clientId, events: [event] };
  const consentBlock = ga4Consent(consent);
  if (consentBlock) body.consent = consentBlock;
  await postJson(url, body);
}

function platformWants(matrix, platform, name) {
  return Array.isArray(matrix?.[platform]) && matrix[platform].includes(name);
}

/**
 * Fan a normalized pixel event out to every server-side destination that (a) is opted into this
 * event in the matrix and (b) has the credentials it needs. settings: TrackingSettings row.
 * event: normalized event from the pixel beacon { name, id, data, context, utm, clientId, fbp, fbc, ... }.
 */
export async function fanOutServerSide(settings, event) {
  if (!settings?.serverSide) return;
  const name = event?.name;
  if (!name) return;

  let keys = {};
  try {
    keys = JSON.parse(settings.serverSideKeys || "{}");
  } catch {
    keys = {};
  }
  let matrix = {};
  try {
    matrix = JSON.parse(settings.eventMatrix || "{}");
  } catch {
    matrix = {};
  }

  const clientId = event.clientId || stableClientId(event.id || event.context?.document?.location?.href);
  const consent = event.consent; // { analytics, marketing } | undefined (treated as granted)
  // Meta carries hashed PII, so it needs marketing consent. GA4/sGTM always send (consent-flagged) so
  // Google can model the no-consent gap (Consent Mode v2). Unknown consent → treated as granted.
  const marketingOk = !consent || consent.marketing;
  const jobs = [];

  if (platformWants(matrix, "ga4", name) && settings.ga4Id && keys.ga4ApiSecret) {
    jobs.push(sendGa4(settings.ga4Id, keys.ga4ApiSecret, clientId, ga4EventFor(name, event), { consent }).catch(() => {}));
  }
  if (marketingOk && platformWants(matrix, "meta", name) && settings.metaPixelId && keys.metaCapiToken) {
    jobs.push(sendMeta(settings.metaPixelId, keys.metaCapiToken, metaEventFor(name, event)).catch(() => {}));
  }
  // GTM server-side: needs the sGTM container URL + a measurement id/secret to deliver the GA4 hit.
  if (platformWants(matrix, "gtm", name) && settings.gtmId && keys.gtmServerUrl) {
    const mid = keys.gtmMeasurementId || settings.ga4Id;
    const secret = keys.gtmApiSecret || keys.ga4ApiSecret;
    if (mid && secret) {
      jobs.push(sendGtmServer(keys.gtmServerUrl, mid, secret, clientId, ga4EventFor(name, event), consent).catch(() => {}));
    }
  }
  // Google Ads needs no integration here — the GA4 purchase above carries the correct client_id, so
  // it stitches to the on-page gtag session that holds the gclid; the merchant links GA4 ↔ Google Ads
  // and imports the conversion. No Google Ads API / developer token / OAuth required.

  await Promise.all(jobs);
}

// Send a FULL GA4 event (name + params, e.g. the subscription_purchase event from orders/paid).
// Forwards the whole params object verbatim (this path is NOT matrix-gated — it's an explicit,
// distinctly-named conversion that never collides with the native purchase). Best-effort.
export async function sendGa4Event(settings, { name, params = {}, clientId } = {}) {
  if (!settings?.serverSide || !settings.ga4Id || !name) return { sent: false };
  let keys = {};
  try {
    keys = JSON.parse(settings.serverSideKeys || "{}");
  } catch {
    return { sent: false };
  }
  if (!keys.ga4ApiSecret) return { sent: false };
  try {
    await sendGa4(settings.ga4Id, keys.ga4ApiSecret, clientId || stableClientId(params.transaction_id), { name, params });
    return { sent: true };
  } catch (e) {
    console.warn("[ga4 mp] subscription event send failed:", e?.message || e);
    return { sent: false };
  }
}
