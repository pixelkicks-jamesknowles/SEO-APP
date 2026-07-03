/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// Integration tests for the SUBSCRIPTION + reconciliation branch of orders/paid (webhooks.orders.paid,
// lines 43-139) — the most complex, revenue-touching path in the app, which webhooks.test.js only
// covered up to the idempotency guard. Exercises the REAL pure builders + sendGa4Event → fetch path;
// only Prisma, HMAC auth, and the Admin-API selling-plan lookup are mocked.
jest.mock("../app/shopify.server.js", () => ({
  __esModule: true,
  authenticate: { webhook: jest.fn() },
  unauthenticated: { admin: jest.fn() },
}));
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));
jest.mock("../app/lib/subscription.server.js", () => ({
  __esModule: true,
  fetchOrderSubscriptions: jest.fn(async () => ({ planByLineId: {}, intervals: {} })),
  resolveIntervalDays: jest.fn(async () => ({})),
}));

import prisma from "../app/db.server.js";
import { authenticate } from "../app/shopify.server.js";
import { action as ordersPaid } from "../app/routes/webhooks.orders.paid.jsx";

const SHOP = "s.myshopify.com";
const req = { request: {} };
const gaCalls = () => (global.fetch?.mock?.calls || []).filter((c) => String(c[0]).includes("google-analytics.com"));

// Server-side + subscription + reconciliation all on, GA4 wired, FX off. eventMatrix opts GA4/Meta into
// the purchase so recordPendingPurchase has something to store.
const SETTINGS = {
  shopDomain: SHOP,
  serverSide: true,
  subscriptionTracking: true,
  reconciliation: true,
  valueMode: "revenue",
  fxMode: "off",
  ga4Id: "G-TEST",
  metaPixelId: "PIX",
  serverSideKeys: JSON.stringify({ ga4ApiSecret: "s", metaCapiToken: "t" }),
  eventMatrix: JSON.stringify({ ga4: ["checkout_completed"], meta: ["checkout_completed"] }),
  subscriptionConfig: "{}",
};

// A subscription order (a line carries a selling_plan_allocation → orderHasSubscription is true).
const subOrder = (over = {}) => ({
  id: 5500000000009,
  currency: "USD",
  current_total_price: "20.00",
  email: "buyer@example.com",
  customer: { id: 7, email: "buyer@example.com" },
  buyer_accepts_marketing: true,
  line_items: [{ id: 1, sku: "SUB-1", title: "Coffee", price: "20.00", quantity: 1, selling_plan_allocation: { selling_plan: { id: 12, name: "Monthly" } } }],
  ...over,
});

const deliver = (payload, webhookId = "wh-paid-1") => {
  authenticate.webhook.mockResolvedValue({ shop: SHOP, payload, webhookId });
  return ordersPaid(req);
};

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  prisma.processedWebhook.findUnique.mockResolvedValue(null); // not yet seen
  prisma.processedWebhook.create.mockResolvedValue({});
  prisma.customerAttribution.findUnique.mockResolvedValue(null); // first order for this customer
  prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
});

describe("orders/paid — subscription conversion branch", () => {
  test("a subscription order sends BOTH GA4 events (subscription_purchase + purchase) and stamps GA4 capture", async () => {
    await deliver(subOrder());

    // Two server-side GA4 hits: the scoped subscription_purchase and the whole-order purchase.
    expect(gaCalls()).toHaveLength(2);
    // GA4 capture stamped for the order so the reconcile pass won't re-send the purchase we just delivered.
    expect(prisma.purchaseCapture.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain_orderId: { shopDomain: SHOP, orderId: "5500000000009" } },
        update: expect.objectContaining({ ga4: true }),
      }),
    );
    // Every paid order is recorded for reconciliation regardless of subscription status.
    expect(prisma.pendingPurchase.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.trackingDaily.upsert).toHaveBeenCalled(); // ordersPaid + delivery counters
  });

  test("a failed GA4 send is queued to the durable outbox (recurring renewals have no pixel fallback)", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    await deliver(subOrder());

    // Both the purchase and subscription_purchase failures are enqueued for retry.
    expect(prisma.deliveryOutbox.create).toHaveBeenCalledTimes(2);
    // A failed purchase must NOT stamp capture (nothing was delivered).
    expect(prisma.purchaseCapture.upsert).not.toHaveBeenCalled();
  });

  test("subscription tracking OFF: still counts + reconciles the order, but sends no subscription GA4 event", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, subscriptionTracking: false });

    await deliver(subOrder());

    expect(gaCalls()).toHaveLength(0);
    expect(prisma.pendingPurchase.upsert).toHaveBeenCalledTimes(1); // reconciliation still records it
    expect(prisma.trackingDaily.upsert).toHaveBeenCalledTimes(1); // ordersPaid only
  });

  test("a NON-subscription order does not fire the server-side purchase (the storefront pixel owns it)", async () => {
    await deliver(subOrder({ line_items: [{ id: 1, sku: "OneOff", title: "Mug", price: "20.00", quantity: 1 }] }));

    expect(gaCalls()).toHaveLength(0);
    expect(prisma.pendingPurchase.upsert).toHaveBeenCalledTimes(1); // but it's still reconciled
  });

  test("strict consent (consentMode on, signals off, no marketing consent) hard-drops the send", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, consentMode: true, consentSignals: false });

    await deliver(subOrder({ buyer_accepts_marketing: false }));

    expect(gaCalls()).toHaveLength(0);
  });

  test("redelivery of the same webhook id is a no-op (no double count, no double send)", async () => {
    prisma.processedWebhook.findUnique.mockResolvedValue({ webhookId: "wh-paid-1" });

    await deliver(subOrder());

    expect(gaCalls()).toHaveLength(0);
    expect(prisma.trackingDaily.upsert).not.toHaveBeenCalled();
    expect(prisma.pendingPurchase.upsert).not.toHaveBeenCalled();
  });
});
