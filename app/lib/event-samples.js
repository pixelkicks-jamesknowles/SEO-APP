// Representative Shopify Web Pixels event payloads for the admin sandbox/preview page. NOT used in
// production - they let the SEO team see exactly what each event would output (through the real
// ga4EventFor / metaEventFor / dataLayerFor builders) without needing a live store.

const variant = (over = {}) => ({
  id: "gid://shopify/ProductVariant/123",
  sku: "AM-9",
  title: "UK 9",
  price: { amount: 60, currencyCode: "GBP" },
  product: { id: "gid://shopify/Product/1", title: "Air Max", vendor: "Nike", type: "Trainers" },
  ...over,
});

const checkout = (withOrder) => ({
  currencyCode: "GBP",
  totalPrice: { amount: 120, currencyCode: "GBP" },
  order: withOrder ? { id: "5500000000001" } : null,
  email: "buyer@example.com",
  phone: "+44 7700 900123",
  shippingAddress: { firstName: "Sam", lastName: "Jones", city: "Leeds", provinceCode: "ENG", zip: "LS1 1AA", countryCode: "GB" },
  lineItems: [{ quantity: 2, title: "Air Max", variant: variant() }],
});

const context = {
  document: { location: { href: "https://shop.example.com/products/air-max?utm_source=google&utm_medium=organic&utm_campaign=spring" } },
  navigator: { userAgent: "Mozilla/5.0 (Macintosh)" },
};

// Identifiers a consented pixel attaches - so the Meta EMQ fields populate in the preview.
const ids = {
  clientId: "1234567890.1700000000",
  fbp: "fb.1.1700000000.1234567890",
  fbc: "fb.1.1700000000.AbCdEf",
  externalId: "gid://shopify/Customer/55",
  userAgent: "Mozilla/5.0 (Macintosh)",
  clientIp: "203.0.113.10",
};

const ev = (name, data, extra = {}) => ({
  name,
  id: `evt_${name}`,
  timestamp: "2026-06-26T10:00:00.000Z",
  data,
  context,
  utm: { utm_source: "google", utm_medium: "organic", utm_campaign: "spring" },
  ...ids,
  ...extra,
});

export const EVENT_SAMPLES = {
  page_viewed: ev("page_viewed", {}),
  product_viewed: ev("product_viewed", { productVariant: variant() }),
  collection_viewed: ev("collection_viewed", {
    collection: { id: "gid://shopify/Collection/9", title: "Trainers", productVariants: [variant(), variant({ sku: "AM-10", title: "UK 10" })] },
  }),
  search_submitted: ev("search_submitted", { searchResult: { query: "running shoes", productVariants: [variant()] } }),
  product_added_to_cart: ev("product_added_to_cart", {
    cartLine: { quantity: 2, merchandise: variant(), cost: { totalAmount: { amount: 120, currencyCode: "GBP" } } },
  }),
  checkout_started: ev("checkout_started", { checkout: checkout(false) }),
  payment_info_submitted: ev("payment_info_submitted", { checkout: checkout(false) }),
  checkout_completed: ev("checkout_completed", { checkout: checkout(true) }),
  // Synthetic SEO-engagement events from the theme app embed.
  scroll: ev("scroll", {}, { params: { percent_scrolled: 75 } }),
  engaged_view: ev("engaged_view", {}, { params: { engagement_time_msec: 15000, percent_scrolled: 60 } }),
};

// subscription_purchase is NOT a Web Pixels event — it's built from an orders/paid order payload by
// buildSubscriptionEvent and sent server-side to GA4. The sandbox handles it via a separate branch.
export const SUBSCRIPTION_SAMPLE = {
  order: {
    id: 5500000000001,
    currency: "GBP",
    current_total_price: "48.00",
    current_total_tax: "8.00",
    total_shipping_price_set: { shop_money: { amount: "3.99" } },
    discount_codes: [{ code: "SUB10" }],
    line_items: [
      {
        sku: "COFFEE-1KG",
        variant_id: 111,
        title: "House Blend 1kg",
        variant_title: "Whole bean",
        price: "24.00",
        quantity: 2,
        total_discount: "0.00",
        selling_plan_allocation: { selling_plan: { name: "Delivery every 1 month" } },
      },
    ],
  },
  // First-touch attribution a recurring order inherits (captured on the first order).
  attribution: { source: "google", medium: "organic", campaign: "spring" },
};

export const SANDBOX_EVENTS = [...Object.keys(EVENT_SAMPLES), "subscription_purchase"];
