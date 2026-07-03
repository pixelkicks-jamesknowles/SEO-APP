/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// orders/paid is now a FAST record-only handler: it counts the order, records it for purchase
// reconciliation, and (for subscription-enabled shops) records it for deferred processing — then ACKs.
// It does NO inline Admin/GA4 work (that moved to processPendingSubscriptions; see process-subscriptions
// .test.js for the conversion-pipeline assertions). These tests pin the fast path + idempotency.
jest.mock("../app/shopify.server.js", () => ({
  __esModule: true,
  authenticate: { webhook: jest.fn() },
  unauthenticated: { admin: jest.fn() },
}));
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { authenticate } from "../app/shopify.server.js";
import { action as ordersPaid } from "../app/routes/webhooks.orders.paid.jsx";

const SHOP = "s.myshopify.com";
const req = { request: {} };
const gaCalls = () => (global.fetch?.mock?.calls || []).filter((c) => String(c[0]).includes("google-analytics.com"));

// Server-side + subscription + reconciliation on, GA4 wired, FX/COGS off. eventMatrix opts GA4/Meta into
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

// A subscription order (a line carries a selling_plan_allocation).
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
  prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
});

describe("orders/paid — fast record-only handler", () => {
  test("records the order for reconciliation AND deferred subscription processing, without any inline GA4 send", async () => {
    await deliver(subOrder());

    // No slow work inline — the conversion sends happen later in processPendingSubscriptions.
    expect(gaCalls()).toHaveLength(0);
    // Every paid order is recorded for purchase reconciliation.
    expect(prisma.pendingPurchase.upsert).toHaveBeenCalledTimes(1);
    // A subscription-enabled shop also records the order for the deferred subscription pass, encrypted.
    expect(prisma.pendingSubscription.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.pendingSubscription.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ shopDomain_orderId: { shopDomain: SHOP, orderId: "5500000000009" } });
    expect(arg.create.payload).toMatch(/^enc:v1:/); // encrypted at rest, not plaintext JSON
    expect(arg.update).toEqual({}); // a redelivery must not reopen a row the pass already closed
    // ordersPaid counted for the Accuracy match-rate denominator.
    expect(prisma.trackingDaily.upsert).toHaveBeenCalled();
  });

  test("subscription tracking OFF: still counts + reconciles the order, but records no subscription row", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, subscriptionTracking: false });

    await deliver(subOrder());

    expect(prisma.pendingPurchase.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.pendingSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.trackingDaily.upsert).toHaveBeenCalledTimes(1); // ordersPaid only
  });

  test("server-side OFF: counts the order but records nothing to deliver", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, serverSide: false });

    await deliver(subOrder());

    expect(prisma.pendingSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.pendingPurchase.upsert).not.toHaveBeenCalled(); // recordPendingPurchase no-ops without serverSide
    expect(prisma.trackingDaily.upsert).toHaveBeenCalledTimes(1); // ordersPaid still counted
  });

  test("a non-subscription order is still recorded (the deferred pass, not the webhook, decides it's a one-off)", async () => {
    // The REST payload can't cheaply prove an order ISN'T a subscription (selling plans need an Admin
    // lookup), so a subscription-enabled shop records every paid order; the cron pass skips the one-offs.
    await deliver(subOrder({ line_items: [{ id: 1, sku: "OneOff", title: "Mug", price: "20.00", quantity: 1 }] }));

    expect(gaCalls()).toHaveLength(0);
    expect(prisma.pendingSubscription.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.pendingPurchase.upsert).toHaveBeenCalledTimes(1);
  });

  test("redelivery of the same webhook id is a no-op (no double count, no double record)", async () => {
    prisma.processedWebhook.findUnique.mockResolvedValue({ webhookId: "wh-paid-1" });

    await deliver(subOrder());

    expect(prisma.trackingDaily.upsert).not.toHaveBeenCalled();
    expect(prisma.pendingPurchase.upsert).not.toHaveBeenCalled();
    expect(prisma.pendingSubscription.upsert).not.toHaveBeenCalled();
  });
});
