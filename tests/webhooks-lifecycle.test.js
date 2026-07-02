/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// Integration tests for the lifecycle / negative-conversion webhooks (orders/cancelled, orders/edited,
// fulfillments/create): feature gating, up-front idempotency claim, and the "skip rather than send a
// wrong value" guards. Same mock boundary as webhooks.test.js — Admin-API lookups are stubbed.
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
jest.mock("../app/lib/lifecycle.server.js", () => ({ __esModule: true, fetchOrderForEdit: jest.fn() }));

import prisma from "../app/db.server.js";
import { authenticate } from "../app/shopify.server.js";
import { fetchOrderForEdit } from "../app/lib/lifecycle.server.js";
import { action as ordersCancelled } from "../app/routes/webhooks.orders.cancelled.jsx";
import { action as ordersEdited } from "../app/routes/webhooks.orders.edited.jsx";
import { action as fulfillmentsCreate } from "../app/routes/webhooks.fulfillments.create.jsx";

const SHOP = "s.myshopify.com";
const req = { request: {} };
const SETTINGS = { shopDomain: SHOP, serverSide: true, refundTracking: true, lifecycleTracking: true, valueMode: "revenue", fxMode: "off", ga4Id: "G-TEST", serverSideKeys: JSON.stringify({ ga4ApiSecret: "s" }), subscriptionConfig: "{}" };
const gaCalls = () => (global.fetch?.mock?.calls || []).filter((c) => String(c[0]).includes("google-analytics.com"));

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  prisma.processedWebhook.create.mockResolvedValue({}); // claim succeeds by default
});

describe("orders/cancelled → GA4 refund", () => {
  const payload = { id: 555, currency: "USD", current_total_price: "48.00", line_items: [{ sku: "X", title: "Item", price: "24.00", quantity: 2 }] };
  const deliver = () => { authenticate.webhook.mockResolvedValue({ shop: SHOP, webhookId: "wh-c1", payload }); return ordersCancelled(req); };

  test("refund tracking off → no claim, no send", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ shopDomain: SHOP, serverSide: true, refundTracking: false });
    await deliver();
    expect(prisma.processedWebhook.create).not.toHaveBeenCalled();
    expect(gaCalls()).toHaveLength(0);
  });

  test("first delivery: claims and sends a GA4 refund for the full order", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
    await deliver();
    expect(prisma.processedWebhook.create).toHaveBeenCalledTimes(1);
    expect(gaCalls()).toHaveLength(1);
  });

  test("lost the claim race → no duplicate send", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
    prisma.processedWebhook.create.mockRejectedValue(new Error("Unique constraint failed"));
    await deliver();
    expect(gaCalls()).toHaveLength(0);
  });
});

describe("orders/edited → GA4 order_edited", () => {
  const payload = { order_edit: { id: 77, order_id: 555 } };
  const deliver = () => { authenticate.webhook.mockResolvedValue({ shop: SHOP, webhookId: "wh-e1", payload }); return ordersEdited(req); };

  test("lifecycle tracking off → no claim, no send", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, lifecycleTracking: false });
    await deliver();
    expect(prisma.processedWebhook.create).not.toHaveBeenCalled();
    expect(gaCalls()).toHaveLength(0);
  });

  test("first delivery: re-fetches the order and sends the new total", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
    fetchOrderForEdit.mockResolvedValue({ id: 555, current_total_price: "50.00", currency: "USD", line_items: [] });
    await deliver();
    expect(prisma.processedWebhook.create).toHaveBeenCalledTimes(1);
    expect(gaCalls()).toHaveLength(1);
  });

  test("order re-fetch fails → claim held but no send (avoids a wrong value)", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
    fetchOrderForEdit.mockResolvedValue(null);
    await deliver();
    expect(prisma.processedWebhook.create).toHaveBeenCalledTimes(1);
    expect(gaCalls()).toHaveLength(0);
  });
});

describe("fulfillments/create → GA4 order_fulfilled", () => {
  const deliver = (payload) => { authenticate.webhook.mockResolvedValue({ shop: SHOP, webhookId: "wh-f1", payload }); return fulfillmentsCreate(req); };

  test("lifecycle tracking off → no send", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, lifecycleTracking: false });
    await deliver({ id: 900, order_id: 555, line_items: [{ sku: "X", quantity: 1 }] });
    expect(gaCalls()).toHaveLength(0);
  });

  test("first delivery: sends order_fulfilled", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
    await deliver({ id: 900, order_id: 555, line_items: [{ sku: "X", quantity: 1, title: "Item" }] });
    expect(gaCalls()).toHaveLength(1);
  });

  test("a fulfillment with no order id builds no event → claim held, nothing sent", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
    await deliver({ id: 900 }); // no order_id → buildFulfillmentEvent returns null
    expect(prisma.processedWebhook.create).toHaveBeenCalledTimes(1);
    expect(gaCalls()).toHaveLength(0);
  });
});
