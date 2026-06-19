// Server-side event fan-out from the app-proxy /track beacon (Pro). Best-effort HTTP POSTs to
// GA4 Measurement Protocol + Meta Conversions API. Untested over localhost (the proxy isn't
// reachable there) — exercised on a deployed host with serverSide enabled + keys set.

// Shopify customer-event → GA4 recommended event name.
const GA4_MAP = {
  product_viewed: "view_item",
  collection_viewed: "view_item_list",
  search_submitted: "search",
  product_added_to_cart: "add_to_cart",
  checkout_started: "begin_checkout",
  checkout_completed: "purchase",
  page_viewed: "page_view",
};

// Shopify customer-event → Meta standard event name.
const META_MAP = {
  product_viewed: "ViewContent",
  search_submitted: "Search",
  product_added_to_cart: "AddToCart",
  checkout_started: "InitiateCheckout",
  checkout_completed: "Purchase",
  page_viewed: "PageView",
};

async function ga4(measurementId, apiSecret, name, clientId) {
  const eventName = GA4_MAP[name] || name;
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  await fetch(url, {
    method: "POST",
    body: JSON.stringify({ client_id: clientId || `${Date.now()}.${Math.random()}`, events: [{ name: eventName, params: {} }] }),
  });
}

async function meta(pixelId, token, name) {
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [{ event_name: META_MAP[name] || name, event_time: Math.floor(Date.now() / 1000), action_source: "website" }],
    }),
  });
}

// settings: TrackingSettings row. event: the normalized event { name, ... } from the pixel beacon.
export async function fanOutServerSide(settings, event) {
  if (!settings?.serverSide) return;
  let keys = {};
  try {
    keys = JSON.parse(settings.serverSideKeys || "{}");
  } catch {
    return;
  }
  const name = event?.name;
  if (!name) return;
  const jobs = [];
  if (settings.ga4Id && keys.ga4ApiSecret) {
    jobs.push(ga4(settings.ga4Id, keys.ga4ApiSecret, name, event?.context?.clientId).catch(() => {}));
  }
  if (settings.metaPixelId && keys.metaCapiToken) {
    jobs.push(meta(settings.metaPixelId, keys.metaCapiToken, name).catch(() => {}));
  }
  await Promise.all(jobs);
}
