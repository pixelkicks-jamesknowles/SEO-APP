/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// Integration tests for the order/refund webhook actions — the idempotency guards and consent/feature
// gating that protect against double-counted conversions on Shopify's at-least-once redelivery. HMAC is
// owned by authenticate.webhook (mocked here); we assert the app's own control flow around it.
jest.mock("../app/shopify.server.js", () => ({
  __esModule: true,
  authenticate: { webhook: jest.fn() },
  unauthenticated: { admin: jest.fn() },
}));
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));
// The Admin-API selling-plan lookup needs an offline session we don't have in tests — stub it empty.
jest.mock("../app/lib/subscription.server.js", () => ({
  __esModule: true,
  fetchOrderSubscriptions: jest.fn(async () => ({ planByLineId: {}, intervals: {} })),
  resolveIntervalDays: jest.fn(async () => ({})),
}));

import prisma from "../app/db.server.js";
import { authenticate } from "../app/shopify.server.js";
import { action as ordersPaid } from "../app/routes/webhooks.orders.paid.jsx";
import { action as refundsCreate } from "../app/routes/webhooks.refunds.create.jsx";

const SHOP = "s.myshopify.com";
const req = { request: {} }; // authenticate.webhook is mocked, so the request itself is irrelevant

const gaCalls = () => (global.fetch?.mock?.calls || []).filter((c) => String(c[0]).includes("google-analytics.com"));

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
});

describe("orders/paid — idempotency + the ordersPaid accuracy counter", () => {
  const deliver = (webhookId) => {
    authenticate.webhook.mockResolvedValue({ shop: SHOP, webhookId, payload: { id: 555, line_items: [] } });
    return ordersPaid(req);
  };

  test("first delivery: claims the webhook and bumps ordersPaid exactly once", async () => {
    prisma.processedWebhook.findUnique.mockResolvedValue(null);
    prisma.trackingSettings.findUnique.mockResolvedValue({ shopDomain: SHOP, serverSide: false }); // tracking off → returns after the counter

    await deliver("wh-1");

    expect(prisma.processedWebhook.create).toHaveBeenCalledTimes(1);
    expect(prisma.trackingDaily.upsert).toHaveBeenCalledTimes(1); // bumpDaily(ordersPaid: 1)
  });

  test("redelivery of the same webhook id: no re-claim, no double count", async () => {
    prisma.processedWebhook.findUnique.mockResolvedValue({ webhookId: "wh-1" }); // already seen

    await deliver("wh-1");

    expect(prisma.processedWebhook.create).not.toHaveBeenCalled();
    expect(prisma.trackingDaily.upsert).not.toHaveBeenCalled(); // the guard protects the denominator
  });

  test("falls back to the order id as the dedupe key when no webhook id is present", async () => {
    prisma.processedWebhook.findUnique.mockResolvedValue(null);
    prisma.trackingSettings.findUnique.mockResolvedValue({ shopDomain: SHOP, serverSide: false });

    await deliver(undefined);

    expect(prisma.processedWebhook.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ webhookId: "order:555" }) }),
    );
  });
});

describe("refunds/create — claim-wins-the-race + feature gating", () => {
  const settingsOn = { shopDomain: SHOP, serverSide: true, refundTracking: true, valueMode: "revenue", fxMode: "off", ga4Id: "G-TEST", serverSideKeys: JSON.stringify({ ga4ApiSecret: "s" }), subscriptionConfig: "{}" };
  const payload = { id: 9, order_id: 555, transactions: [{ amount: "10.00", currency: "USD", kind: "refund" }], refund_line_items: [] };

  test("refund tracking off → returns without claiming or sending", async () => {
    authenticate.webhook.mockResolvedValue({ shop: SHOP, webhookId: "wh-r1", payload });
    prisma.trackingSettings.findUnique.mockResolvedValue({ shopDomain: SHOP, serverSide: true, refundTracking: false });

    await refundsCreate(req);

    expect(prisma.processedWebhook.create).not.toHaveBeenCalled();
    expect(gaCalls()).toHaveLength(0);
  });

  test("first delivery: wins the claim and sends the GA4 refund", async () => {
    authenticate.webhook.mockResolvedValue({ shop: SHOP, webhookId: "wh-r1", payload });
    prisma.trackingSettings.findUnique.mockResolvedValue(settingsOn);
    prisma.processedWebhook.create.mockResolvedValue({}); // claim succeeds

    await refundsCreate(req);

    expect(gaCalls()).toHaveLength(1);
    expect(gaCalls()[0][0]).toContain("mp/collect");
  });

  test("concurrent redelivery loses the claim (unique-key conflict) → no duplicate send", async () => {
    authenticate.webhook.mockResolvedValue({ shop: SHOP, webhookId: "wh-r1", payload });
    prisma.trackingSettings.findUnique.mockResolvedValue(settingsOn);
    prisma.processedWebhook.create.mockRejectedValue(new Error("Unique constraint failed on webhookId")); // lost the race

    await refundsCreate(req);

    expect(gaCalls()).toHaveLength(0); // bailed before sending
  });
});
