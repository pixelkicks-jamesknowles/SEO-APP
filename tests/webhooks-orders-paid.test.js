/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// orders/paid is now a FAST handler: it counts the order, records it for purchase reconciliation, and —
// for subscription shops — records it then kicks off immediate delivery in the background (not awaited),
// then ACKs. It does NO slow work inline. The subscription-cron module is mocked here (the immediate kick
// is fire-and-forget, so running the real pipeline would be racy); its conversion assertions live in
// process-subscriptions.test.js. These tests pin the fast path, what gets recorded/kicked, and idempotency.
jest.mock("../app/shopify.server.js", () => ({
  __esModule: true,
  authenticate: { webhook: jest.fn() },
  unauthenticated: { admin: jest.fn() },
}));
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));
jest.mock("../app/lib/subscription-cron.server.js", () => ({
  __esModule: true,
  recordPendingSubscription: jest.fn(async () => {}),
  processSubscriptionNow: jest.fn(async () => {}),
}));

import prisma from "../app/db.server.js";
import { authenticate } from "../app/shopify.server.js";
import { recordPendingSubscription, processSubscriptionNow } from "../app/lib/subscription-cron.server.js";
import { action as ordersPaid } from "../app/routes/webhooks.orders.paid.jsx";

const SHOP = "s.myshopify.com";
const req = { request: {} };

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

describe("orders/paid — fast record + immediate-kick handler", () => {
  test("records the order for reconciliation + deferred delivery, and kicks off immediate delivery", async () => {
    const payload = subOrder();
    await deliver(payload);

    // Every paid order is recorded for purchase reconciliation.
    expect(prisma.pendingPurchase.upsert).toHaveBeenCalledTimes(1);
    // A subscription-enabled shop records the order, then fires immediate delivery (not awaited).
    expect(recordPendingSubscription).toHaveBeenCalledWith(SHOP, payload);
    expect(processSubscriptionNow).toHaveBeenCalledWith(SHOP, payload, { settings: SETTINGS });
    // ordersPaid counted for the Accuracy match-rate denominator.
    expect(prisma.trackingDaily.upsert).toHaveBeenCalled();
  });

  test("subscription tracking OFF: still counts + reconciles, but neither records nor kicks a subscription", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, subscriptionTracking: false });

    await deliver(subOrder());

    expect(prisma.pendingPurchase.upsert).toHaveBeenCalledTimes(1);
    expect(recordPendingSubscription).not.toHaveBeenCalled();
    expect(processSubscriptionNow).not.toHaveBeenCalled();
    expect(prisma.trackingDaily.upsert).toHaveBeenCalledTimes(1); // ordersPaid only
  });

  test("server-side OFF: counts the order but records nothing to deliver", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, serverSide: false });

    await deliver(subOrder());

    expect(recordPendingSubscription).not.toHaveBeenCalled();
    expect(processSubscriptionNow).not.toHaveBeenCalled();
    expect(prisma.pendingPurchase.upsert).not.toHaveBeenCalled(); // recordPendingPurchase no-ops without serverSide
    expect(prisma.trackingDaily.upsert).toHaveBeenCalledTimes(1); // ordersPaid still counted
  });

  test("a non-subscription order is still recorded + kicked (the delivery path, not the webhook, decides it's a one-off)", async () => {
    const payload = subOrder({ line_items: [{ id: 1, sku: "OneOff", title: "Mug", price: "20.00", quantity: 1 }] });
    await deliver(payload);

    expect(recordPendingSubscription).toHaveBeenCalledWith(SHOP, payload);
    expect(processSubscriptionNow).toHaveBeenCalledTimes(1);
    expect(prisma.pendingPurchase.upsert).toHaveBeenCalledTimes(1);
  });

  test("redelivery of the same webhook id is a no-op (no double count, no double record or kick)", async () => {
    prisma.processedWebhook.findUnique.mockResolvedValue({ webhookId: "wh-paid-1" });

    await deliver(subOrder());

    expect(prisma.trackingDaily.upsert).not.toHaveBeenCalled();
    expect(prisma.pendingPurchase.upsert).not.toHaveBeenCalled();
    expect(recordPendingSubscription).not.toHaveBeenCalled();
    expect(processSubscriptionNow).not.toHaveBeenCalled();
  });
});
