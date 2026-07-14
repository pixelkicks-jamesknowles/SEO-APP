// Server-side event fan-out from the app-proxy /track beacon. Builds COMPLETE GA4 Measurement
// Protocol + Meta Conversions API payloads (items, value, currency, transaction_id, dedup ids,
// hashed user data) and forwards to GA4, Meta CAPI and — when configured — a server-side GTM
// container. Best-effort: every send is fire-and-catch so a destination outage never breaks the
// storefront. Pure builders (extractCommerce / ga4EventFor / metaEventFor / parseGaClientId /
// sha256Hex / stableClientId) are exported and unit-tested without network IO.
import crypto from "node:crypto";
import { readServerSideKeys } from "./secrets.server";
import { fetchWithTimeout } from "./net.server";

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

// Shopify customer-event → TikTok Events API standard event. page_viewed is intentionally absent (TikTok
// has no PageView standard event); an unmapped name passes through as a TikTok custom event.
const TIKTOK_MAP = {
  product_viewed: "ViewContent",
  collection_viewed: "ViewContent",
  search_submitted: "Search",
  product_added_to_cart: "AddToCart",
  checkout_started: "InitiateCheckout",
  payment_info_submitted: "AddPaymentInfo",
  checkout_completed: "CompletePayment",
};

// Shopify customer-event → Pinterest Conversions API event_name. Pinterest requires one of its enums or
// "custom", so anything unmapped falls back to "custom".
const PINTEREST_MAP = {
  page_viewed: "page_visit",
  product_viewed: "page_visit",
  collection_viewed: "view_category",
  search_submitted: "search",
  product_added_to_cart: "add_to_cart",
  checkout_completed: "checkout",
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Trailing run of digits from an order id (handles a numeric id, "gid://shopify/Order/123", etc.).
 *  Canonicalizes the order id so every code path (pixel, reconcile backfill, outbox retry) derives the
 *  SAME dedup keys — GA4 transaction_id and the Meta event_id — for a given order. Pure. */
export function numericId(x) {
  if (x == null) return null;
  const m = String(x).match(/\d+/g);
  return m ? m[m.length - 1] : null;
}

/** Deterministic, order-scoped Meta/Snap/etc. event_id for a purchase ("order:<numeric id>"), or null
 *  when there's no order id. Shared by the pixel path and the reconcile backfill so both dedup. Pure. */
export function purchaseEventId(orderId) {
  const id = numericId(orderId);
  return id ? `order:${id}` : null;
}

/** SHA-256 hex of a normalized string (Meta requires lower-cased, trimmed, hashed PII). */
export function sha256Hex(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

/** SHA-256 of a value with ALL non-alphanumerics removed (lower-cased). This is the correct
 *  normalization for Meta/Snap city + zip, which strip internal spaces and punctuation before hashing
 *  ("New York" → "newyork", "LS1 1AA" → "ls11aa"). Hashing the un-stripped value would never match
 *  the platform's own hash, silently lowering Event Match Quality. */
export function sha256HexCompact(value) {
  if (!value) return null;
  const compact = String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact ? crypto.createHash("sha256").update(compact).digest("hex") : null;
}

/** Digits-only phone: the normalization Meta / Pinterest / Snap CAPI expect (country code, no + or
 *  symbols) before SHA-256. */
export function normalizePhoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

/** E.164 phone WITH the leading "+" — the normalization Google Ads Enhanced Conversions and TikTok
 *  Events API require before SHA-256. Stripping the "+" (digits-only) makes the hash mismatch the
 *  platform's, so phone-only matches silently fail on those two — hence a distinct normalizer. */
export function normalizePhoneE164(phone) {
  const digits = normalizePhoneDigits(phone);
  return digits ? `+${digits}` : "";
}

/** Microsoft-style email normalization before SHA-256: lower-case, strip an "+alias" suffix and remove
 *  all dots from the local part (Microsoft UET / Bing hashes the email this way, so hashing the raw form
 *  would never match theirs). Returns "" for a non-email. Pure. */
export function normalizeEmail(email) {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at < 1) return "";
  const local = raw.slice(0, at).split("+")[0].replace(/\./g, "");
  const domain = raw.slice(at + 1);
  return local && domain ? `${local}@${domain}` : "";
}

/** Deterministic, order-scoped dedup id for a purchase ("order:<numeric id>"), else the Shopify event
 *  id. Shared by every destination whose purchase can also be fired by a merchant's own client-side
 *  pixel (TikTok/Snap/Pinterest) so the two collapse instead of double-counting. Pure. */
export function dedupIdFor(name, ev) {
  const orderScoped = name === "checkout_completed" ? purchaseEventId(ev?.data?.checkout?.order?.id) : null;
  return orderScoped || (ev?.id ? String(ev.id) : undefined);
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
    // Storefront customer-event items don't carry selling-plan data, so we can't tell subscription status
    // here — default to 0 (numeric, matching the purchase/refund builders) so the item_subscription custom
    // dimension is never "(not set)". Authoritative subscription tagging comes from the orders/paid pipeline
    // (subscription.js), whose purchase dedupes against this one on transaction_id.
    item_subscription: 0,
    item_subscription_interval: 0,
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
    // Canonicalize to the NUMERIC order id so GA4's transaction_id de-dup key matches across the pixel
    // path (order.id is a gid://shopify/Order/<n>) and the reconcile backfill (a bare numeric id), and
    // against the native Google & YouTube app's client-side purchase. Falls back to the checkout token
    // only when there's no order id yet.
    out.transactionId = numericId(co?.order?.id) || co?.token || null;
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
  // City + zip use compact normalization (Meta/Snap strip internal spaces + punctuation before hashing).
  const putCompact = (key, value) => {
    const h = sha256HexCompact(value);
    if (h) user_data[key] = [h];
  };
  put("em", checkout?.email || ev?.email);
  put("ph", normalizePhoneDigits(checkout?.phone || ev?.phone));
  put("fn", addr.firstName);
  put("ln", addr.lastName);
  putCompact("ct", addr.city);
  putCompact("st", addr.provinceCode || addr.province); // Meta strips spaces/punctuation from state too
  putCompact("zp", addr.zip);
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

  // For a purchase, the event_id MUST be a deterministic, order-scoped id ("order:<numeric order id>")
  // so the two server-side paths that can both fire a Purchase — the storefront pixel and the reconcile
  // backfill — carry the SAME id and Meta collapses them. Non-purchase events keep the Shopify event id,
  // which dedups against a client-side pixel hit. (Shared with TikTok/Snap/Pinterest via dedupIdFor.)
  return {
    event_name: META_MAP[name] || (ev?.custom && CUSTOM_META_MAP[name]) || name,
    event_time: Math.floor((ev?.timestamp ? Date.parse(ev.timestamp) : Date.now()) / 1000),
    event_id: dedupIdFor(name, ev),
    action_source: "website",
    event_source_url: ev?.context?.document?.location?.href || undefined,
    user_data,
    custom_data,
  };
}

// Which of the Meta match keys a built user_data block actually carries. Column names match the
// MatchQualityDaily model, so the ingest path can bump per-identifier coverage counters (Event Match
// Quality is driven by identifier coverage). Pure — unit-tested.
const META_ID_COLUMNS = {
  em: "em", ph: "ph", fn: "fn", ln: "ln", ct: "ct", st: "st", zp: "zp", country: "country",
  external_id: "externalId", fbp: "fbp", fbc: "fbc", client_ip_address: "clientIp", client_user_agent: "userAgent",
};
export function metaIdentifierKeys(userData) {
  const out = [];
  for (const [k, col] of Object.entries(META_ID_COLUMNS)) {
    const v = userData?.[k];
    if (Array.isArray(v) ? v.length : v) out.push(col);
  }
  return out;
}

/** Build a TikTok Events API event object for a Shopify event (hashed PII + ttp/ttclid + commerce). */
export function tiktokEventFor(name, ev) {
  const c = extractCommerce(name, ev?.data);
  const checkout = ev?.data?.checkout;
  const user = {};
  if (ev?.ttp) user.ttp = ev.ttp;
  if (ev?.ttclid) user.ttclid = ev.ttclid;
  if (ev?.clientIp) user.ip = ev.clientIp;
  if (ev?.userAgent) user.user_agent = ev.userAgent;
  const em = sha256Hex(checkout?.email || ev?.email);
  if (em) user.email = em;
  // TikTok requires E.164 (with the leading "+") before hashing — digits-only would never match.
  const ph = sha256Hex(normalizePhoneE164(checkout?.phone || ev?.phone));
  if (ph) user.phone = ph;
  if (ev?.externalId) user.external_id = sha256Hex(String(ev.externalId));
  const properties = {};
  if (c.currency) properties.currency = c.currency;
  if (c.value != null) properties.value = c.value;
  if (c.items.length) {
    properties.content_type = "product";
    properties.contents = c.items.map((i) => ({ content_id: String(i.item_id), content_name: i.item_name, quantity: i.quantity, price: i.price }));
  }
  if (name === "checkout_completed" && c.transactionId) properties.order_id = c.transactionId;
  return {
    event: TIKTOK_MAP[name] || name,
    event_time: Math.floor((ev?.timestamp ? Date.parse(ev.timestamp) : Date.now()) / 1000),
    // Order-scoped for a purchase so it dedups against a merchant's own client-side TikTok pixel hit.
    event_id: dedupIdFor(name, ev),
    user,
    page: { url: ev?.context?.document?.location?.href || undefined },
    properties,
  };
}

/** Build a Pinterest Conversions API event object for a Shopify event (hashed PII arrays + commerce). */
export function pinterestEventFor(name, ev) {
  const c = extractCommerce(name, ev?.data);
  const checkout = ev?.data?.checkout;
  const user_data = {};
  if (ev?.clientIp) user_data.client_ip_address = ev.clientIp;
  if (ev?.userAgent) user_data.client_user_agent = ev.userAgent;
  const em = sha256Hex(checkout?.email || ev?.email);
  if (em) user_data.em = [em];
  // Pinterest CAPI expects digits-only phone (country code, no "+").
  const ph = sha256Hex(normalizePhoneDigits(checkout?.phone || ev?.phone));
  if (ph) user_data.ph = [ph];
  if (ev?.externalId) user_data.external_id = [sha256Hex(String(ev.externalId))];
  if (ev?.epik) user_data.click_id = ev.epik;
  const custom_data = {};
  if (c.currency) custom_data.currency = c.currency;
  if (c.value != null) custom_data.value = String(c.value); // Pinterest expects value as a string
  if (c.items.length) {
    custom_data.content_ids = c.items.map((i) => String(i.item_id));
    custom_data.contents = c.items.map((i) => ({ id: String(i.item_id), quantity: i.quantity, item_price: String(i.price) }));
    custom_data.num_items = c.items.reduce((s, i) => s + i.quantity, 0);
  }
  if (name === "checkout_completed" && c.transactionId) custom_data.order_id = c.transactionId;
  return {
    event_name: PINTEREST_MAP[name] || "custom",
    action_source: "web",
    event_time: Math.floor((ev?.timestamp ? Date.parse(ev.timestamp) : Date.now()) / 1000),
    // Order-scoped for a purchase so it dedups against a merchant's own client-side Pinterest tag hit.
    event_id: dedupIdFor(name, ev),
    event_source_url: ev?.context?.document?.location?.href || undefined,
    user_data,
    custom_data,
  };
}

const KLAVIYO_API_REVISION = "2026-04-15";

// Shopify customer-event → Klaviyo metric name. Deliberately EXCLUDES checkout_completed: Klaviyo's
// native Shopify integration already emits "Placed Order" / "Ordered Product" server-to-server, so
// sending our own would double-count in flows and reports (the same single-emitter rule the pixel
// scanner enforces). What we add is the ONSITE events Klaviyo otherwise loses when its on-page JS can't
// run — the abandonment/browse signals that drive its flows. An unmapped standard event → no send.
const KLAVIYO_MAP = {
  product_viewed: "Viewed Product",
  product_added_to_cart: "Added to Cart",
  checkout_started: "Started Checkout",
};

// The identifiers a Klaviyo profile can be keyed on. Klaviyo drops an event that carries no profile
// identifier, so the presence of one of these also decides whether a job is built at all.
function klaviyoProfile(ev) {
  const checkout = ev?.data?.checkout;
  const addr = checkout?.shippingAddress || checkout?.billingAddress || {};
  const attrs = {};
  const email = checkout?.email || ev?.email;
  const phone = (checkout?.phone || ev?.phone || "").trim();
  if (email) attrs.email = String(email).trim().toLowerCase();
  if (phone) attrs.phone_number = phone; // Klaviyo wants E.164 as sent; it normalizes server-side
  if (ev?.externalId) attrs.external_id = String(ev.externalId);
  if (addr.firstName) attrs.first_name = addr.firstName;
  if (addr.lastName) attrs.last_name = addr.lastName;
  return attrs;
}

/**
 * Build a Klaviyo Events API body for a Shopify event, or null when it must NOT be sent — i.e. the
 * event is neither a mapped onsite metric nor a custom (window.pxp.track) event, OR there's no profile
 * identifier to attach it to. Klaviyo dedups on unique_id (= the Shopify event id), so a replayed
 * beacon collapses. Unlike the ad CAPIs, PII is NOT hashed here — Klaviyo matches profiles on the
 * raw email/phone.
 */
export function klaviyoEventFor(name, ev) {
  const metricName = KLAVIYO_MAP[name] || (ev?.custom ? name : null);
  if (!metricName) return null;
  const profile = klaviyoProfile(ev);
  if (!profile.email && !profile.phone_number && !profile.external_id) return null; // unattributable
  const c = extractCommerce(name, ev?.data);
  const properties = {};
  if (c.items.length) {
    properties.Items = c.items.map((i) => ({ ProductID: i.item_id, ProductName: i.item_name, Quantity: i.quantity, ItemPrice: i.price }));
    if (c.items.length === 1) {
      properties.ProductID = c.items[0].item_id;
      properties.ProductName = c.items[0].item_name;
    }
  }
  const url = ev?.context?.document?.location?.href;
  if (url) properties.URL = url;
  // Custom / lead events carry value/currency in ev.params (no commerce extraction).
  const value = c.value != null ? c.value : ev?.custom && ev?.params?.value != null ? num(ev.params.value) : null;
  const currency = c.currency || (ev?.custom ? ev?.params?.currency : null);
  const attributes = {
    properties,
    metric: { data: { type: "metric", attributes: { name: metricName } } },
    profile: { data: { type: "profile", attributes: profile } },
    time: ev?.timestamp || new Date().toISOString(),
  };
  if (value != null) attributes.value = value;
  if (currency) attributes.value_currency = currency;
  if (ev?.id) attributes.unique_id = String(ev.id);
  return { data: { type: "event", attributes } };
}

// Shopify customer-event → Snapchat Conversions API (v3) event_name. Snap's v3 web schema mirrors Meta
// CAPI (data[] of { event_name, event_time(s), user_data, custom_data }), so we reuse the same hashed
// user_data and commerce extraction. An unmapped name passes through as-is (Snap treats unknown as custom).
const SNAP_MAP = {
  page_viewed: "PAGE_VIEW",
  product_viewed: "VIEW_CONTENT",
  collection_viewed: "VIEW_CONTENT",
  search_submitted: "SEARCH",
  product_added_to_cart: "ADD_CART",
  checkout_started: "START_CHECKOUT",
  payment_info_submitted: "ADD_BILLING",
  checkout_completed: "PURCHASE",
};

/** Build a Snapchat Conversions API (v3) event for a Shopify event. Same hashed PII as Meta (minus the
 *  Meta-only fbp/fbc cookies) + commerce; value is a string, like Pinterest. Deduped by Snap on event_id. */
export function snapEventFor(name, ev) {
  const c = extractCommerce(name, ev?.data);
  const user_data = metaUserData(ev);
  delete user_data.fbp; // Meta-only cookies — meaningless to Snap
  delete user_data.fbc;
  // Snap's own first-party browser id (_scid) + click id raise match quality the way fbp/fbc do for Meta.
  if (ev?.scid) user_data.uuid_c1 = ev.scid;
  if (ev?.scclid) user_data.sc_click_id = ev.scclid;
  const custom_data = {};
  if (c.currency) custom_data.currency = c.currency;
  if (c.value != null) custom_data.value = String(c.value); // Snap expects value as a string
  if (c.items.length) {
    custom_data.content_ids = c.items.map((i) => String(i.item_id));
    custom_data.contents = c.items.map((i) => ({ id: String(i.item_id), quantity: i.quantity, item_price: String(i.price) }));
    custom_data.num_items = c.items.reduce((s, i) => s + i.quantity, 0);
  }
  if (name === "checkout_completed" && c.transactionId) custom_data.order_id = c.transactionId;
  if (ev?.custom && ev?.params) {
    if (ev.params.value != null) custom_data.value = String(num(ev.params.value));
    if (ev.params.currency) custom_data.currency = ev.params.currency;
  }
  return {
    event_name: SNAP_MAP[name] || name,
    event_time: Math.floor((ev?.timestamp ? Date.parse(ev.timestamp) : Date.now()) / 1000),
    // Order-scoped for a purchase so it dedups against a merchant's own client-side Snap pixel hit.
    event_id: dedupIdFor(name, ev),
    action_source: "WEB",
    event_source_url: ev?.context?.document?.location?.href || undefined,
    user_data,
    custom_data,
  };
}

// Shopify customer-event → Reddit Conversions API tracking_type. Reddit has a small standard set; an
// unmapped name is delivered as a "Custom" type carrying the original name (checkout_started /
// payment_info_submitted have no Reddit standard equivalent).
const REDDIT_MAP = {
  page_viewed: "PageVisit",
  product_viewed: "ViewContent",
  collection_viewed: "ViewContent",
  search_submitted: "Search",
  product_added_to_cart: "AddToCart",
  checkout_completed: "Purchase",
};

/** Build a Reddit Conversions API event for a Shopify event. Reddit hashes email/external_id/IP with
 *  SHA-256 (user_agent stays raw), and carries commerce under event_metadata (value as value_decimal). */
export function redditEventFor(name, ev) {
  const c = extractCommerce(name, ev?.data);
  const checkout = ev?.data?.checkout;
  const user = {};
  const em = sha256Hex(checkout?.email || ev?.email);
  if (em) user.email = em;
  if (ev?.externalId) user.external_id = sha256Hex(String(ev.externalId));
  if (ev?.clientIp) user.ip_address = sha256Hex(ev.clientIp); // Reddit expects the IP SHA-256 hashed
  if (ev?.userAgent) user.user_agent = ev.userAgent; // user agent is NOT hashed
  const event_metadata = {};
  // conversion_id is Reddit's de-dup key: it collapses an outbox retry that actually reached Reddit,
  // and a matching client-side Reddit Pixel hit. Order-scoped for a purchase (so it's stable across the
  // pixel + any backfill), else the Shopify event id. Without this, every Reddit retry double-counted.
  const redditDedupId = dedupIdFor(name, ev);
  if (redditDedupId) event_metadata.conversion_id = redditDedupId;
  if (c.currency) event_metadata.currency = c.currency;
  if (c.value != null) event_metadata.value_decimal = c.value;
  if (c.items.length) {
    event_metadata.item_count = c.items.reduce((s, i) => s + i.quantity, 0);
    event_metadata.products = c.items.map((i) => ({ id: String(i.item_id), name: i.item_name || undefined, category: i.item_category || undefined }));
  }
  if (ev?.custom && ev?.params) {
    if (ev.params.value != null) event_metadata.value_decimal = num(ev.params.value);
    if (ev.params.currency) event_metadata.currency = ev.params.currency;
  }
  const trackingType = REDDIT_MAP[name] || "Custom";
  const event_type = { tracking_type: trackingType };
  if (trackingType === "Custom") event_type.custom_event_name = name;
  return {
    event_at: ev?.timestamp || new Date().toISOString(), // ISO 8601
    event_type,
    user,
    event_metadata,
  };
}

// LinkedIn Conversions API (REST). Server-side B2B conversions matched on a SHA-256 email and/or the
// LinkedIn first-party ad-tracking id (li_fat_id). Unlike the ad-CAPIs above, the timestamp is epoch
// MILLISECONDS and the value is nested under conversionValue{currencyCode, amount(string)}. Returns null
// when there's no match key (no email and no li_fat_id) so no unattributable job is built.
export function linkedinEventFor(name, ev) {
  const c = extractCommerce(name, ev?.data);
  const checkout = ev?.data?.checkout;
  const userIds = [];
  const em = sha256Hex(checkout?.email || ev?.email);
  if (em) userIds.push({ idType: "SHA256_EMAIL", idValue: em });
  const liFat = ev?.liFatId || ev?.li_fat_id;
  if (liFat) userIds.push({ idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: String(liFat) });
  if (!userIds.length) return null; // nothing LinkedIn can match on → skip
  const event = {
    conversionHappenedAt: ev?.timestamp ? Date.parse(ev.timestamp) : Date.now(), // epoch MS (LinkedIn spec)
    user: { userIds },
  };
  // eventId dedups against a client-side LinkedIn Insight Tag conversion; order-scoped for a purchase so
  // it's stable across the pixel + any retry (shared helper with the other destinations).
  const eventId = dedupIdFor(name, ev);
  if (eventId) event.eventId = eventId;
  const value = c.value != null ? c.value : ev?.custom && ev?.params?.value != null ? num(ev.params.value) : null;
  const currency = c.currency || (ev?.custom ? ev?.params?.currency : null);
  if (value != null && currency) event.conversionValue = { currencyCode: currency, amount: String(value) };
  return event;
}

// Shopify customer-event → Microsoft UET (Bing) event. `eventName` is what the merchant keys a custom
// conversion goal on; `pageType` is the ecommerce hint UET uses for dynamic remarketing. An unmapped
// name passes its own name through as a custom event.
const BING_MAP = {
  page_viewed: { eventName: "page_view", pageType: "home" },
  product_viewed: { eventName: "view_item", pageType: "product" },
  collection_viewed: { eventName: "view_item_list", pageType: "category" },
  search_submitted: { eventName: "search", pageType: "searchresults" },
  product_added_to_cart: { eventName: "add_to_cart", pageType: "cart" },
  checkout_started: { eventName: "begin_checkout", pageType: "cart" },
  payment_info_submitted: { eventName: "add_payment_info", pageType: "cart" },
  checkout_completed: { eventName: "purchase", pageType: "purchase" },
};

/** Build a Microsoft UET (Bing) Conversions API custom event. Hashes email (Microsoft-normalized) +
 *  phone (E.164), carries the msclkid click id + anonymousId for match, and commerce under customData.
 *  Deduped by Bing on eventId (order-scoped for a purchase → collapses vs a client-side UET tag hit). */
export function bingEventFor(name, ev) {
  const c = extractCommerce(name, ev?.data);
  const checkout = ev?.data?.checkout;
  const map = BING_MAP[name] || { eventName: name };
  const userData = {};
  if (ev?.userAgent) userData.clientUserAgent = ev.userAgent;
  if (ev?.clientIp) userData.clientIpAddress = ev.clientIp;
  // anonymousId ties a visitor's events together (and matches the client-side ID-sync vid if present).
  if (ev?.clientId) userData.anonymousId = String(ev.clientId);
  const em = sha256Hex(normalizeEmail(checkout?.email || ev?.email));
  if (em) userData.em = em;
  const ph = sha256Hex(normalizePhoneE164(checkout?.phone || ev?.phone));
  if (ph) userData.ph = ph;
  if (ev?.externalId) userData.externalId = String(ev.externalId);
  if (ev?.msclkid) userData.msclkid = ev.msclkid; // Microsoft last-click id (the strongest match key)
  const customData = {};
  if (map.pageType) customData.pageType = map.pageType;
  if (c.currency) customData.currency = c.currency;
  if (c.value != null) {
    customData.value = c.value;
    customData.ecommTotalValue = c.value;
  }
  if (c.items.length) {
    customData.items = c.items.map((i) => ({ id: String(i.item_id), quantity: i.quantity, price: i.price, name: i.item_name || undefined }));
    customData.itemIds = c.items.map((i) => String(i.item_id));
  }
  if (name === "checkout_completed" && c.transactionId) customData.transactionId = c.transactionId;
  if (ev?.custom && ev?.params) {
    if (ev.params.value != null) customData.value = customData.ecommTotalValue = num(ev.params.value);
    if (ev.params.currency) customData.currency = ev.params.currency;
  }
  const event = {
    eventType: "custom",
    eventName: map.eventName || name,
    eventTime: Math.floor((ev?.timestamp ? Date.parse(ev.timestamp) : Date.now()) / 1000), // UNIX seconds
    userData,
    customData,
  };
  const eventId = dedupIdFor(name, ev);
  if (eventId) event.eventId = eventId;
  const url = ev?.context?.document?.location?.href;
  if (url) event.eventSourceUrl = url;
  // Consent Mode: reflect marketing consent as Bing's adStorageConsent (G=granted / D=denied). Unknown
  // consent → omit (Bing defaults to granted).
  if (ev?.consent) event.adStorageConsent = ev.consent.marketing ? "G" : "D";
  return event;
}

// Best-effort POST that never throws; returns { ok, detail } for the delivery health log.
// `validate(json)` (optional) inspects the parsed response body for destinations that return HTTP 200
// even when they REJECTED the event (Meta: 200 + { error } / events_received:0; TikTok: 200 + code!=0).
// Without it those look "delivered" and are never retried — a silent conversion loss. It returns
// { ok, detail } to override the status-only verdict, or undefined to accept it. The body is only read
// when the response actually exposes .json() (real fetch), so status-only test mocks are unaffected.
async function postJson(url, body, headers = {}, validate) {
  try {
    const res = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    let ok = res.ok;
    let detail = String(res.status);
    if (validate && typeof res.json === "function") {
      const json = await res.json().catch(() => null);
      const verdict = json ? validate(json) : null;
      if (verdict) {
        ok = verdict.ok;
        if (verdict.detail) detail = verdict.detail;
      }
    }
    return { ok, detail };
  } catch (e) {
    return { ok: false, detail: e?.name === "AbortError" ? "timeout" : e?.message || "network error" };
  }
}

// Google Consent Mode v2 signals for the GA4 MP `consent` block. marketing → ad signals,
// analytics → (GA4 storage is implied by sending; we flag the ad consent state Google needs to model).
export function ga4Consent(consent) {
  if (!consent) return undefined; // unknown (e.g. subscription webhook) → omit, treated as granted
  const g = (v) => (v ? "GRANTED" : "DENIED");
  return { ad_user_data: g(consent.marketing), ad_personalization: g(consent.marketing) };
}

/** Value-based optimisation. Mutates a GA4 params object or a Meta custom_data object in place, keeping
 *  the raw amount as `revenue` and replacing `value` with the optimisation target, so ad platforms bid
 *  on profit instead of top-line. Two modes:
 *    - "margin": value = revenue × marginPct% (a flat whole-percent margin).
 *    - "cogs":   value = revenue − cost (true profit from Shopify's per-variant "Cost per item"),
 *                clamped at ≥0 so a below-cost order never sends a negative conversion value.
 *  No-op for "revenue", a non-numeric value, or cogs mode with no resolved cost (→ falls back to
 *  revenue, so a cost-lookup failure never zeroes a conversion). */
export function withValueMode(target, valueMode, marginPct, cost) {
  if (typeof target?.value !== "number") return target;
  if (valueMode === "margin") {
    target.revenue = target.value;
    target.value = Math.round(target.value * (Number(marginPct) || 0)) / 100;
  } else if (valueMode === "cogs" && cost != null && Number.isFinite(Number(cost))) {
    target.revenue = target.value;
    target.value = Math.max(0, Math.round((target.value - Number(cost)) * 100) / 100);
  }
  return target;
}

// GA4 joins a Measurement Protocol hit to an existing browser session — and thus inherits that session's
// traffic source (Session source / channel group) — only when it gets client_id + session_id + the hit's
// REAL time. Without timestamp_micros GA4 stamps the event at receipt time, so anything that arrives after
// the session ended (a reconcile backfill, an outbox retry hours later) misses the session, starts a fresh
// source-less one, and reports as "Unassigned" / "(not set)". Every other destination already sends the
// true event time; GA4 was the only one that didn't.
//
// GA4 accepts backdating up to 72h and DROPS anything older, so past that we omit the timestamp rather
// than lose the conversion entirely (it lands, just unattributed). Pure — unit-tested.
export const GA4_MAX_BACKDATE_MS = 72 * 60 * 60 * 1000;
export function ga4TimestampMicros(ts, now = Date.now()) {
  const t = ts ? Date.parse(ts) : NaN;
  if (Number.isNaN(t)) return null;
  if (t > now + 60_000) return null; // future / clock skew → let GA4 stamp it
  if (now - t > GA4_MAX_BACKDATE_MS) return null; // older than GA4's window → it would drop the event
  return String(t * 1000);
}

async function sendGa4(measurementId, apiSecret, clientId, event, { endpoint, consent, timestampMicros } = {}) {
  const base = endpoint || "https://www.google-analytics.com";
  const url = `${base.replace(/\/$/, "")}/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  const body = { client_id: clientId, events: [event] };
  if (timestampMicros) body.timestamp_micros = timestampMicros;
  const consentBlock = ga4Consent(consent);
  if (consentBlock) body.consent = consentBlock;
  return postJson(url, body);
}

async function sendMeta(pixelId, token, event) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;
  // Meta returns HTTP 200 with an { error } block (bad token/pixel/payload) or events_received:0 even
  // when it rejected the event; treat those as failures so the outbox retries instead of silently losing.
  return postJson(url, { data: [event] }, {}, (json) => {
    if (json.error) return { ok: false, detail: (json.error.message || "meta error").slice(0, 200) };
    if (json.events_received === 0) return { ok: false, detail: "meta events_received=0" };
    return undefined;
  });
}

// TikTok Events API 1.3: server-to-server web events. Access-Token in the header, the pixel code as
// event_source_id. Like the others this only inspects HTTP status for the health log.
async function sendTiktok(pixelCode, token, event) {
  const body = { event_source: "web", event_source_id: pixelCode, data: [event] };
  // TikTok returns HTTP 200 with a non-zero `code` (+ message) when it rejects the event; treat that as
  // a failure so it retries rather than being logged as delivered.
  return postJson("https://business-api.tiktok.com/open_api/v1.3/event/track/", body, { "Access-Token": token }, (json) =>
    json.code != null && json.code !== 0 ? { ok: false, detail: (json.message || `tiktok code ${json.code}`).slice(0, 200) } : undefined,
  );
}

// Pinterest Conversions API (v5): events are posted under an ad account, Bearer-authed.
async function sendPinterest(adAccountId, token, event) {
  const url = `https://api.pinterest.com/v5/ad_accounts/${encodeURIComponent(adAccountId)}/events`;
  return postJson(url, { data: [event] }, { Authorization: `Bearer ${token}` });
}

// Klaviyo Events API: the private API key goes in the Authorization header, the revision pins the
// JSON:API schema version. Success is a 202 (postJson treats any 2xx as ok). The event body is already
// the full JSON:API envelope from klaviyoEventFor.
async function sendKlaviyo(apiKey, event) {
  return postJson("https://a.klaviyo.com/api/events", event, {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_API_REVISION,
    Accept: "application/vnd.api+json",
  });
}

// Snapchat Conversions API (v3): the pixel id is in the path, the access token is a query param.
async function sendSnap(pixelId, token, event) {
  const url = `https://tr.snapchat.com/v3/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;
  return postJson(url, { data: [event] });
}

// Reddit Conversions API (v2.0): events are posted under the pixel/advertiser id in the path, Bearer-authed.
async function sendReddit(pixelId, token, event) {
  const url = `https://ads-api.reddit.com/api/v2.0/conversions/events/${encodeURIComponent(pixelId)}`;
  return postJson(url, { events: [event] }, { Authorization: `Bearer ${token}` });
}

// LinkedIn Conversions API: one conversion object POSTed to /rest/conversionEvents, Bearer-authed, with
// the versioned REST headers. The conversion-rule urn goes in the body (built from the numeric id, or
// passed through if the merchant saved the full urn). Returns HTTP 201 on success (postJson treats 2xx ok).
const LINKEDIN_VERSION = "202406";
async function sendLinkedin(conversionId, token, event) {
  const id = String(conversionId);
  const conversion = id.startsWith("urn:") ? id : `urn:lla:llaPartnerConversion:${id.replace(/\D/g, "")}`;
  return postJson("https://api.linkedin.com/rest/conversionEvents", { conversion, ...event }, {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  });
}

// Microsoft UET (Bing) Conversions API: server-to-server events POSTed under the UET tag id, Bearer-authed
// with the CAPI token from the Microsoft Advertising UI. Returns HTTP 200 on success, or 400/401 with an
// { error: { code, message } } body when rejected — surface that so the outbox retries instead of losing it.
async function sendBing(tagId, token, event) {
  const url = `https://capi.uet.microsoft.com/v1/${encodeURIComponent(tagId)}/events`;
  return postJson(url, { data: [event] }, { Authorization: `Bearer ${token}` }, (json) =>
    json.error ? { ok: false, detail: (json.error.message || json.error.code || "bing error").slice(0, 200) } : undefined,
  );
}

// Send a Meta CAPI test event (tagged with a test_event_code so it shows under Test Events, not live
// reporting) to verify the pixel id + CAPI token end-to-end. Returns { ok, messages }.
export async function validateMetaEvent(settings, { testEventCode } = {}) {
  const keys = readServerSideKeys(settings);
  if (!settings?.metaPixelId) return { ok: false, messages: ["No Meta pixel ID set."] };
  if (!keys.metaCapiToken) return { ok: false, messages: ["No Meta CAPI access token saved."] };
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(settings.metaPixelId)}/events?access_token=${encodeURIComponent(keys.metaCapiToken)}`;
  const event = {
    event_name: "PageView",
    event_time: Math.floor(Date.now() / 1000),
    event_id: `pixelify-test-${Date.now()}`,
    action_source: "website",
    user_data: { client_user_agent: "pixelify-diagnostics" },
  };
  const body = { data: [event] };
  if (testEventCode) body.test_event_code = testEventCode;
  try {
    const res = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && (json.events_received >= 1 || json.events_received === undefined)) return { ok: true, messages: [] };
    const msg = json?.error?.message || `HTTP ${res.status}`;
    return { ok: false, messages: [msg] };
  } catch (e) {
    return { ok: false, messages: [e?.message || "Request to Meta failed."] };
  }
}

// Server-side GTM: GTM-XXXX is a *web* container the strict pixel sandbox cannot load (no gtag.js),
// so the only server-side route is a sGTM container URL with a GA4 client — we POST the GA4 MP hit to it.
async function sendGtmServer(serverUrl, measurementId, apiSecret, clientId, event, consent, timestampMicros) {
  const url = `${serverUrl.replace(/\/$/, "")}/g/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  const body = { client_id: clientId, events: [event] };
  // Same session-join requirement as the direct GA4 path — sGTM forwards this on to GA4.
  if (timestampMicros) body.timestamp_micros = timestampMicros;
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
 * Deliver ONE already-built job to its destination, re-reading the shop's credentials from settings
 * at call time (jobs never carry secrets, so this is safe after a credential rotation). Shared by the
 * live fan-out and the retry worker (outbox.server.js), so a queued retry sends byte-identically.
 * job: { destination, eventName, event, clientId?, consent? }. Returns { ok, detail }.
 */
export async function deliverOne(settings, job) {
  const keys = readServerSideKeys(settings);
  // timestampMicros rides on the JOB (not the event), so an outbox retry hours later still reports the
  // ORIGINAL event time and can still join the right session.
  const { destination, event, clientId, consent, timestampMicros } = job || {};
  switch (destination) {
    case "ga4":
      if (!settings?.ga4Id || !keys.ga4ApiSecret) return { ok: false, detail: "GA4 not configured" };
      return sendGa4(settings.ga4Id, keys.ga4ApiSecret, clientId, event, { consent, timestampMicros });
    case "meta":
      if (!settings?.metaPixelId || !keys.metaCapiToken) return { ok: false, detail: "Meta not configured" };
      return sendMeta(settings.metaPixelId, keys.metaCapiToken, event);
    case "tiktok":
      if (!settings?.tiktokPixelId || !keys.tiktokAccessToken) return { ok: false, detail: "TikTok not configured" };
      return sendTiktok(settings.tiktokPixelId, keys.tiktokAccessToken, event);
    case "pinterest":
      if (!keys.pinterestAccessToken || !keys.pinterestAdAccountId) return { ok: false, detail: "Pinterest not configured" };
      return sendPinterest(keys.pinterestAdAccountId, keys.pinterestAccessToken, event);
    case "klaviyo":
      if (!keys.klaviyoApiKey) return { ok: false, detail: "Klaviyo not configured" };
      return sendKlaviyo(keys.klaviyoApiKey, event);
    case "snapchat":
      if (!settings?.snapPixelId || !keys.snapAccessToken) return { ok: false, detail: "Snapchat not configured" };
      return sendSnap(settings.snapPixelId, keys.snapAccessToken, event);
    case "reddit":
      if (!settings?.redditPixelId || !keys.redditAccessToken) return { ok: false, detail: "Reddit not configured" };
      return sendReddit(settings.redditPixelId, keys.redditAccessToken, event);
    case "linkedin":
      if (!settings?.linkedinConversionId || !keys.linkedinAccessToken) return { ok: false, detail: "LinkedIn not configured" };
      return sendLinkedin(settings.linkedinConversionId, keys.linkedinAccessToken, event);
    case "bing":
      if (!settings?.bingUetId || !keys.bingCapiToken) return { ok: false, detail: "Bing not configured" };
      return sendBing(settings.bingUetId, keys.bingCapiToken, event);
    case "gtm": {
      if (!keys.gtmServerUrl) return { ok: false, detail: "sGTM not configured" };
      const mid = keys.gtmMeasurementId || settings?.ga4Id;
      const secret = keys.gtmApiSecret || keys.ga4ApiSecret;
      if (!mid || !secret) return { ok: false, detail: "sGTM measurement id/secret missing" };
      return sendGtmServer(keys.gtmServerUrl, mid, secret, clientId, event, consent, timestampMicros);
    }
    case "google_ads": {
      // Dynamically imported so this module stays prisma-free (google-ads.server reads the DB token).
      const { deliverGoogleAds } = await import("./google-ads.server");
      return deliverGoogleAds(settings, job);
    }
    default:
      return { ok: false, detail: `unknown destination: ${destination}` };
  }
}

/**
 * Build the delivery jobs for a normalized pixel event — every server-side destination that (a) is
 * opted into this event in the matrix and (b) has the credentials it needs. Pure (no IO), so it's
 * unit-testable and mirrors exactly what fan-out will attempt. Returns [{ destination, eventName,
 * event, clientId, consent }]. `hooks` lets later features mutate the built GA4/Meta payloads (e.g.
 * currency normalization) and contribute extra jobs (e.g. Google Ads) without bloating this core.
 */
export function buildJobs(settings, event, { force = false, hooks = {} } = {}) {
  if (!settings?.serverSide) return [];
  const name = event?.name;
  if (!name) return [];
  const keys = readServerSideKeys(settings);
  let matrix = {};
  try {
    matrix = JSON.parse(settings.eventMatrix || "{}");
  } catch {
    matrix = {};
  }

  const clientId = event.clientId || stableClientId(event.id || event.context?.document?.location?.href);
  // The event's REAL time, so a GA4/sGTM hit delivered later (reconcile backfill, outbox retry) still
  // joins the session it actually belongs to instead of starting a source-less one.
  const timestampMicros = ga4TimestampMicros(event.timestamp);
  const consent = event.consent; // { analytics, marketing } | undefined (treated as granted)
  // Meta carries hashed PII, so it needs marketing consent. GA4/sGTM always send (consent-flagged) so
  // Google can model the no-consent gap (Consent Mode v2). Unknown consent → treated as granted.
  const marketingOk = !consent || consent.marketing;
  // force (test sends) and custom/lead events (window.pxp.track) bypass the per-event matrix — they go
  // to every configured destination (still credential- and consent-gated).
  const wants = (p) => force || event?.custom || platformWants(matrix, p, name);

  // Build the GA4 event once; apply value-based optimisation (margin/COGS profit) to the purchase
  // conversion. event.orderCost (resolved from Shopify's per-variant cost on the ingest/reconcile path)
  // is the COGS input — absent for non-cogs modes, so it's simply ignored there.
  const ga4Event = ga4EventFor(name, event);
  const isPurchaseConv = name === "checkout_completed";
  if (isPurchaseConv) withValueMode(ga4Event.params, settings.valueMode, settings.marginPct, event.orderCost);
  hooks.normalizeParams?.(ga4Event.params);

  const jobs = [];
  // For a subscription checkout, the GA4 purchase comes from the orders/paid webhook (all items) plus
  // a scoped subscription_purchase — so suppress the pixel's GA4 purchase here to avoid doubling GA4
  // revenue. Meta/GTM below still fire (they aren't sent by the webhook and want the pixel's cookies).
  //
  // Only suppress when subscription tracking is actually ON — that's the only case where the webhook
  // delivers the GA4 purchase. With it OFF the webhook sends nothing, so suppressing here would drop the
  // GA4 purchase entirely (permanent loss when reconciliation is also off). Gate on the setting, not just
  // the line-item shape.
  const suppressGa4Purchase = isPurchaseConv && !!settings.subscriptionTracking && checkoutHasSubscription(event);
  if (wants("ga4") && settings.ga4Id && keys.ga4ApiSecret && !suppressGa4Purchase) {
    jobs.push({ destination: "ga4", eventName: name, event: ga4Event, clientId, consent, timestampMicros });
  }
  if (marketingOk && wants("meta") && settings.metaPixelId && keys.metaCapiToken) {
    const metaEvent = metaEventFor(name, event);
    if (isPurchaseConv) withValueMode(metaEvent.custom_data, settings.valueMode, settings.marginPct, event.orderCost);
    hooks.normalizeParams?.(metaEvent.custom_data);
    jobs.push({ destination: "meta", eventName: name, event: metaEvent });
  }
  // GTM server-side: needs the sGTM container URL + a measurement id/secret to deliver the GA4 hit.
  if (wants("gtm") && settings.gtmId && keys.gtmServerUrl && (keys.gtmMeasurementId || settings.ga4Id)) {
    jobs.push({ destination: "gtm", eventName: name, event: ga4Event, clientId, consent, timestampMicros });
  }
  // TikTok Events API: carries hashed PII, so it's marketing-consent-gated like Meta. Needs the pixel
  // code (settings.tiktokPixelId) + an access token in serverSideKeys.
  if (marketingOk && wants("tiktok") && settings.tiktokPixelId && keys.tiktokAccessToken) {
    const ttEvent = tiktokEventFor(name, event);
    if (isPurchaseConv) withValueMode(ttEvent.properties, settings.valueMode, settings.marginPct, event.orderCost);
    hooks.normalizeParams?.(ttEvent.properties);
    jobs.push({ destination: "tiktok", eventName: name, event: ttEvent });
  }
  // Pinterest Conversions API: also marketing-consent-gated. Needs the tag id + an ad-account id and
  // token in serverSideKeys. (Value-mode/margin isn't applied here — Pinterest wants value as a string.)
  if (marketingOk && wants("pinterest") && settings.pinterestId && keys.pinterestAccessToken && keys.pinterestAdAccountId) {
    jobs.push({ destination: "pinterest", eventName: name, event: pinterestEventFor(name, event) });
  }
  // Klaviyo Events API: onsite browse/abandonment events (Viewed Product / Added to Cart / Started
  // Checkout) delivered server-side so they survive the sandbox and feed Klaviyo flows. Carries raw
  // PII → marketing-consent-gated. klaviyoEventFor returns null for an unmapped event or one with no
  // profile identifier (a logged-out product view, a page_view), so those build no job. Gated purely on
  // the private key — Klaviyo needs no separate on-page pixel id for server-side events.
  if (marketingOk && wants("klaviyo") && keys.klaviyoApiKey) {
    const klaviyoEvent = klaviyoEventFor(name, event);
    if (klaviyoEvent) jobs.push({ destination: "klaviyo", eventName: name, event: klaviyoEvent });
  }
  // Snapchat Conversions API + Reddit Conversions API: both carry hashed PII → marketing-consent-gated.
  // Value-mode/FX normalization isn't applied (Snap wants value as a string, Reddit as value_decimal),
  // matching the Pinterest treatment — they deliver the raw amount.
  if (marketingOk && wants("snapchat") && settings.snapPixelId && keys.snapAccessToken) {
    jobs.push({ destination: "snapchat", eventName: name, event: snapEventFor(name, event) });
  }
  if (marketingOk && wants("reddit") && settings.redditPixelId && keys.redditAccessToken) {
    jobs.push({ destination: "reddit", eventName: name, event: redditEventFor(name, event) });
  }
  // LinkedIn Conversions API: hashed-PII B2B conversions → marketing-consent-gated. Needs the conversion
  // id + an access token; linkedinEventFor returns null when there's no email/li_fat_id to match on
  // (e.g. an anonymous page_view), so those build no job.
  if (marketingOk && wants("linkedin") && settings.linkedinConversionId && keys.linkedinAccessToken) {
    const liEvent = linkedinEventFor(name, event);
    if (liEvent) jobs.push({ destination: "linkedin", eventName: name, event: liEvent });
  }
  // Microsoft UET (Bing) Conversions API: hashed-PII enhanced conversions → marketing-consent-gated.
  // Needs the UET tag id + a CAPI token. Value-mode/FX isn't applied (raw amount), matching Pinterest/
  // Snap/Reddit — Bing carries value + ecommTotalValue directly.
  if (marketingOk && wants("bing") && settings.bingUetId && keys.bingCapiToken) {
    jobs.push({ destination: "bing", eventName: name, event: bingEventFor(name, event) });
  }
  // Extra jobs from later features (e.g. Google Ads Enhanced Conversions on a purchase).
  for (const extra of hooks.extraJobs?.(event, ga4Event, { clientId, consent, isPurchaseConv }) || []) {
    jobs.push(extra);
  }
  return jobs;
}

/**
 * Fan a normalized pixel event out to every configured server-side destination. Delivers each job via
 * deliverOne and returns a delivery-health record per job (incl. the job itself, so a caller can queue
 * the failures for retry — see enqueueFailures in outbox.server.js).
 * event: normalized event from the pixel beacon { name, id, data, context, utm, clientId, fbp, fbc, ... }.
 */
export async function fanOutServerSide(settings, event, { force = false, hooks } = {}) {
  const jobs = buildJobs(settings, event, { force, hooks });
  return Promise.all(
    jobs.map((job) =>
      deliverOne(settings, job)
        .then((r) => ({ destination: job.destination, eventName: job.eventName, ok: !!r?.ok, detail: r?.detail || "", job }))
        .catch((e) => ({ destination: job.destination, eventName: job.eventName, ok: false, detail: e?.message || "error", job })),
    ),
  );
}

// Validate a GA4 event against the Measurement Protocol debug endpoint, which (unlike the real
// endpoint, that always returns 204) reports payload problems. Returns { ok, messages }.
export async function validateGa4Event(settings, { name, params = {}, clientId } = {}) {
  const keys = readServerSideKeys(settings);
  if (!settings?.ga4Id) return { ok: false, messages: ["No GA4 measurement ID set."] };
  if (!keys.ga4ApiSecret) return { ok: false, messages: ["No GA4 Measurement Protocol secret saved."] };
  const url = `https://www.google-analytics.com/debug/mp/collect?measurement_id=${encodeURIComponent(settings.ga4Id)}&api_secret=${encodeURIComponent(keys.ga4ApiSecret)}`;
  try {
    const res = await fetchWithTimeout(url, { method: "POST", body: JSON.stringify({ client_id: clientId || "test.0", events: [{ name, params }] }) });
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
export async function sendGa4Event(settings, { name, params = {}, clientId, sessionId, timestampMicros } = {}, { consent } = {}) {
  if (!settings?.serverSide || !settings.ga4Id || !name) return { sent: false };
  const keys = readServerSideKeys(settings);
  if (!keys.ga4ApiSecret) return { sent: false, detail: "no GA4 secret" };
  // consent (optional): { analytics, marketing } → GA4 Consent Mode v2 flags, mirroring the pixel so
  // consent-declined server-side conversions are modeled rather than dropped. engagement_time_msec is
  // added (GA4 MP best practice) so these server-side conversions register as engaged activity.
  const resolvedClientId = clientId || stableClientId(params.transaction_id);
  // session_id joins this server-side conversion to the shopper's REAL browser session, so GA4 gives it
  // that session's traffic source. Without it GA4 opens a new, source-less session and the purchase
  // reports as "Unassigned". Only ever sent paired with its own client_id (see subscription-cron).
  const withSession = sessionId && !params.session_id ? { session_id: String(sessionId), ...params } : params;
  const event = { name, params: { engagement_time_msec: 1, ...withSession } };
  const r = await sendGa4(settings.ga4Id, keys.ga4ApiSecret, resolvedClientId, event, { consent, timestampMicros });
  // `job` mirrors a buildJobs "ga4" job so a failed webhook send can be queued for retry (outbox)
  // and re-sent byte-identically by deliverOne — carrying timestampMicros so the retry still reports the
  // ORIGINAL event time and can still join the shopper's session.
  return { sent: r.ok, detail: r.detail, job: { destination: "ga4", eventName: name, event, clientId: resolvedClientId, consent, timestampMicros } };
}
