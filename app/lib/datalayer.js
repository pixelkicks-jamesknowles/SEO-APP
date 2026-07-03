// Effective GTM data-layer config the storefront embed reads from the app-proxy /config endpoint.
// Pure (takes a TrackingSettings row) so it's unit-testable and identical on server + in tests.
//
// enabled is the persisted dataLayerEnabled flag — the Pro gate is applied at TOGGLE time (requirePro
// in the settings action), so a merchant can't flip it on from the theme editor to bypass billing; the
// storefront only ever sees the server's authoritative value here.

// The browse-funnel events the embed emits. Purchase is intentionally absent — Shopify's checkout is no
// longer themeable, so purchase is delivered server-side (GA4 MP + reconciliation), never via the web
// data layer.
export const DATA_LAYER_EVENTS = [
  "view_item",
  "view_item_list",
  "add_to_cart",
  "view_cart",
  "begin_checkout",
  "user_data",
];

export function effectiveDataLayerConfig(settings) {
  return {
    enabled: Boolean(settings?.dataLayerEnabled),
    // Emit both the GA4-standard event and its Elevar-compatible dl_* mirror per interaction.
    formats: ["ga4", "dl"],
    events: DATA_LAYER_EVENTS,
  };
}
