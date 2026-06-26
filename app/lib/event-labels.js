// Friendly, client-facing labels for the raw Shopify/synthetic event names. Used across the admin
// UI so the SEO team and clients see "Purchase", not "checkout_completed".
export const EVENT_LABELS = {
  page_viewed: "Page viewed",
  product_viewed: "Product viewed",
  collection_viewed: "Collection viewed",
  search_submitted: "Search submitted",
  product_added_to_cart: "Added to cart",
  checkout_started: "Checkout started",
  payment_info_submitted: "Payment info submitted",
  checkout_completed: "Purchase (checkout completed)",
  scroll: "Scroll depth",
  engaged_view: "Engaged content view",
  subscription_purchase: "Subscription purchase",
};

export const eventLabel = (name) => EVENT_LABELS[name] || name;
