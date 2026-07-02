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
// Common GA4 lead-event names → Meta standard events (better Meta optimisation than a custom name).
// Custom events not listed here pass through as a Meta custom event of the same name.
const CUSTOM_META_MAP = {
  generate_lead: "Lead",
  sign_up: "CompleteRegistration",
  contact: "Contact",
  submit_application: "SubmitApplication",
  schedule: "Schedule",
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
  const out = { currency: null, value: null, transactionId: null, items: [], listId: null, listName: null };
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
    out.listId = data.collection?.id ? String(data.collection.id) : null;
    out.listName = data.collection?.title || null;
  } else if (name === "search_submitted") {
    out.items = (data.searchResult?.productVariants || []).map((v) => toItem(v, 1)).filter(Boolean);
  }
  return out;
}

/** Build a GA4 Measurement Protocol event object { name, params } for a Shopify event. */
export function ga4EventFor(name, ev) {
  const c = extractCommerce(name, ev?.data);
  const params = { engagement_time_msec: 1 };
  // session_id (from the pixel's `_ga_<container>` cookie) so this server-side hit attributes to the
  // same GA4 session gtag created — GA4 MP best practice for report visibility.
  if (ev?.sessionId) params.session_id = String(ev.sessionId);
  const url = ev?.context?.document?.location?.href;
  if (url) params.page_location = url;
  if (c.currency) params.currency = c.currency;
  if (c.value != null) params.value = c.value;
  // transaction_id is GA4's purchase de-dup key — matching the native order id lets GA4 collapse
  // our server-side purchase with the Google & YouTube app's client-side one.
  if (name === "checkout_completed" && c.transactionId) params.transaction_id = c.transactionId;
  if (c.items.length) params.items = c.items.map((it, i) => ({ ...it, index: i }));
  // Collection view → GA4 view_item_list with the list identity (populates list reports).
  if (name === "collection_viewed") {
    if (c.listId) params.item_list_id = c.listId;
    if (c.listName) params.item_list_name = c.listName;
  }
  // Internal site search → a complete GA4 `search` event (search_term is what SEO teams report on).
  if (name === "search_submitted") {
    const q = ev?.data?.searchResult?.query;
    if (q) params.search_term = q;
  }
  for (const [k, utm] of Object.entries(ev?.utm || {})) params[k] = utm;
  // Multi-touch attribution (from cross-session visitor history): first-touch (original source),
  // last-touch (latest campaign visit) and touch count, so a conversion in a later/direct session
  // keeps its journey. Sent as custom params (register as GA4 custom dimensions).
  if (ev?.firstTouch) {
    const ft = ev.firstTouch;
    if (ft.source) params.first_source = ft.source;
    if (ft.medium) params.first_medium = ft.medium;
    if (ft.campaign) params.first_campaign = ft.campaign;
    if (ft.lastSource) params.last_source = ft.lastSource;
    if (ft.lastMedium) params.last_medium = ft.lastMedium;
    if (ft.lastCampaign) params.last_campaign = ft.lastCampaign;
    if (ft.touchCount) params.touch_count = ft.touchCount;
  }
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
  // Custom / lead events carry their value/currency in event.params (no commerce extraction).
  if (ev?.custom && ev?.params) {
    if (ev.params.value != null) custom_data.value = num(ev.params.value);
    if (ev.params.currency) custom_data.currency = ev.params.currency;
  }

  return {
    event_name: META_MAP[name] || (ev?.custom && CUSTOM_META_MAP[name]) || name,
    event_time: Math.floor((ev?.timestamp ? Date.parse(ev.timestamp) : Date.now()) / 1000),
    // event_id = the Shopify event id, so Meta de-dups this against any client-side pixel hit.
    event_id: ev?.id ? String(ev.id) : undefined,
    action_source: "website",
    event_source_url: ev?.context?.document?.location?.href || undefined,
    user_data,
    custom_data,
  };
}

// Best-effort POST that never throws; returns { ok, detail } for the delivery health log.
async function postJson(url, body, headers = {}) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { ok: res.ok, detail: String(res.status) };
  } catch (e) {
    return { ok: false, detail: e?.message || "network error" };
  }
}

// Google Consent Mode v2 signals for the GA4 MP `consent` block. marketing → ad signals,
// analytics → (GA4 storage is implied by sending; we flag the ad consent state Google needs to model).
export function ga4Consent(consent) {
  if (!consent) return undefined; // unknown (e.g. subscription webhook) → omit, treated as granted
  const g = (v) => (v ? "GRANTED" : "DENIED");
  return { ad_user_data: g(consent.marketing), ad_personalization: g(consent.marketing) };
}

/** Value-based optimisation: when valueMode is "margin", set `value` = value × marginPct% (2dp) and
 *  keep the raw amount as `revenue`, so ad platforms optimise for profit. Mutates in place; works on a
 *  GA4 params object or a Meta custom_data object. No-op unless margin mode + a numeric value. */
export function withValueMode(target, valueMode, marginPct) {
  if (valueMode !== "margin" || typeof target?.value !== "number") return target;
  target.revenue = target.value;
  target.value = Math.round(target.value * (Number(marginPct) || 0)) / 100;
  return target;
}

async function sendGa4(measurementId, apiSecret, clientId, event, { endpoint, consent } = {}) {
  const base = endpoint || "https://www.google-analytics.com";
  const url = `${base.replace(/\/$/, "")}/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  const body = { client_id: clientId, events: [event] };
  const consentBlock = ga4Consent(consent);
  if (consentBlock) body.consent = consentBlock;
  return postJson(url, body);
}

async function sendMeta(pixelId, token, event) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;
  return postJson(url, { data: [event] });
}

// Server-side GTM: GTM-XXXX is a *web* container the strict pixel sandbox cannot load (no gtag.js),
// so the only server-side route is a sGTM container URL with a GA4 client — we POST the GA4 MP hit to it.
async function sendGtmServer(serverUrl, measurementId, apiSecret, clientId, event, consent) {
  const url = `${serverUrl.replace(/\/$/, "")}/g/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  const body = { client_id: clientId, events: [event] };
  const consentBlock = ga4Consent(consent);
  if (consentBlock) body.consent = consentBlock;
  return postJson(url, body);
}

function platformWants(matrix, platform, name) {
  return Array.isArray(matrix?.[platform]) && matrix[platform].includes(name);
}

// Known bots / crawlers / headless agents whose hits shouldn't reach ad platforms as conversions.
const BOT_RE = /bot\b|crawl|spider|slurp|bingbot|bingpreview|yandex|baidu|duckduck|facebookexternalhit|embedly|quora|pinterest\/|slackbot|telegram|whatsapp|headless|phantom|puppeteer|playwright|lighthouse|gtmetrix|pingdom|uptime|statuscake|curl\/|wget\/|python-requests|axios\/|node-fetch|go-http|java\/|ahrefs|semrush|mj12|dotbot|petalbot/i;
export function isBot(ua) {
  return typeof ua === "string" && ua.length > 0 && BOT_RE.test(ua);
}

// True if a checkout_completed pixel event contains a subscription line. Shopify exposes
// checkout.lineItems[].sellingPlanAllocation.sellingPlan on Checkout-Extensibility stores. When true,
// the GA4 `purchase` is delivered server-side from the orders/paid webhook instead (avoids double-
// counting GA4 revenue); Meta/GTM still fire from the pixel to keep their cookie-based match quality.
export function checkoutHasSubscription(event) {
  const lines = event?.data?.checkout?.lineItems || [];
  return lines.some((li) => li?.sellingPlanAllocation?.sellingPlan || li?.sellingPlan);
}

/**
 * Fan a normalized pixel event out to every server-side destination that (a) is opted into this
 * event in the matrix and (b) has the credentials it needs. settings: TrackingSettings row.
 * event: normalized event from the pixel beacon { name, id, data, context, utm, clientId, fbp, fbc, ... }.
 */
export async function fanOutServerSide(settings, event, { force = false } = {}) {
  if (!settings?.serverSide) return [];
  const name = event?.name;
  if (!name) return [];

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
  // force (test sends) bypasses the per-event matrix, delivering to every configured destination.
  // Custom / lead events (window.pxp.track) bypass the per-event matrix — they go to every configured
  // destination (still credential- and consent-gated). force = test sends.
  const wants = (p) => force || event?.custom || platformWants(matrix, p, name);
  const tasks = [];
  // Each task resolves to a delivery-health record { destination, eventName, ok, detail }.
  const track = (destination, promise) =>
    tasks.push(
      Promise.resolve(promise)
        .then((r) => ({ destination, eventName: name, ok: !!r?.ok, detail: r?.detail || "" }))
        .catch((e) => ({ destination, eventName: name, ok: false, detail: e?.message || "error" })),
    );

  // Build the GA4 event once; apply value-based optimisation (margin) to the purchase conversion.
  const ga4Event = ga4EventFor(name, event);
  const isPurchaseConv = name === "checkout_completed";
  if (isPurchaseConv) withValueMode(ga4Event.params, settings.valueMode, settings.marginPct);

  // For a subscription checkout, the GA4 purchase comes from the orders/paid webhook (all items) plus
  // a scoped subscription_purchase — so suppress the pixel's GA4 purchase here to avoid doubling GA4
  // revenue. Meta/GTM below still fire (they aren't sent by the webhook and want the pixel's cookies).
  const suppressGa4Purchase = isPurchaseConv && checkoutHasSubscription(event);
  if (wants("ga4") && settings.ga4Id && keys.ga4ApiSecret && !suppressGa4Purchase) {
    track("ga4", sendGa4(settings.ga4Id, keys.ga4ApiSecret, clientId, ga4Event, { consent }));
  }
  if (marketingOk && wants("meta") && settings.metaPixelId && keys.metaCapiToken) {
    const metaEvent = metaEventFor(name, event);
    if (isPurchaseConv) withValueMode(metaEvent.custom_data, settings.valueMode, settings.marginPct);
    track("meta", sendMeta(settings.metaPixelId, keys.metaCapiToken, metaEvent));
  }
  // GTM server-side: needs the sGTM container URL + a measurement id/secret to deliver the GA4 hit.
  if (wants("gtm") && settings.gtmId && keys.gtmServerUrl) {
    const mid = keys.gtmMeasurementId || settings.ga4Id;
    const secret = keys.gtmApiSecret || keys.ga4ApiSecret;
    if (mid && secret) {
      track("gtm", sendGtmServer(keys.gtmServerUrl, mid, secret, clientId, ga4Event, consent));
    }
  }
  // Google Ads needs no integration here - the GA4 purchase above carries the correct client_id, so
  // it stitches to the on-page gtag session that holds the gclid; the merchant links GA4 to Google Ads
  // and imports the conversion. No Google Ads API / developer token / OAuth required.

  return Promise.all(tasks);
}

// Validate a GA4 event against the Measurement Protocol debug endpoint, which (unlike the real
// endpoint, that always returns 204) reports payload problems. Returns { ok, messages }.
export async function validateGa4Event(settings, { name, params = {}, clientId } = {}) {
  let keys = {};
  try {
    keys = JSON.parse(settings?.serverSideKeys || "{}");
  } catch {
    return { ok: false, messages: ["Server-side credentials are not valid JSON."] };
  }
  if (!settings?.ga4Id) return { ok: false, messages: ["No GA4 measurement ID set."] };
  if (!keys.ga4ApiSecret) return { ok: false, messages: ["No GA4 Measurement Protocol secret saved."] };
  const url = `https://www.google-analytics.com/debug/mp/collect?measurement_id=${encodeURIComponent(settings.ga4Id)}&api_secret=${encodeURIComponent(keys.ga4ApiSecret)}`;
  try {
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ client_id: clientId || "test.0", events: [{ name, params }] }) });
    const json = await res.json().catch(() => ({}));
    const messages = (json.validationMessages || []).map((m) => m.description || m.validationCode || JSON.stringify(m));
    return { ok: messages.length === 0, messages };
  } catch (e) {
    return { ok: false, messages: [e?.message || "Request to GA4 failed."] };
  }
}

// Send a FULL GA4 event (name + params, e.g. the subscription_purchase event from orders/paid).
// Forwards the whole params object verbatim (this path is NOT matrix-gated — it's an explicit,
// distinctly-named conversion that never collides with the native purchase). Best-effort.
export async function sendGa4Event(settings, { name, params = {}, clientId } = {}, { consent } = {}) {
  if (!settings?.serverSide || !settings.ga4Id || !name) return { sent: false };
  let keys = {};
  try {
    keys = JSON.parse(settings.serverSideKeys || "{}");
  } catch {
    return { sent: false };
  }
  if (!keys.ga4ApiSecret) return { sent: false, detail: "no GA4 secret" };
  // consent (optional): { analytics, marketing } → GA4 Consent Mode v2 flags, mirroring the pixel so
  // consent-declined server-side conversions are modeled rather than dropped. engagement_time_msec is
  // added (GA4 MP best practice) so these server-side conversions register as engaged activity.
  const r = await sendGa4(settings.ga4Id, keys.ga4ApiSecret, clientId || stableClientId(params.transaction_id), { name, params: { engagement_time_msec: 1, ...params } }, { consent });
  return { sent: r.ok, detail: r.detail };
}
