/* eslint-disable import/first -- jest.mock() must precede the imports it intercepts */
// Integration test for the purchase-reconciliation backstop. Exercises the REAL builders + deliverOne →
// fetch path; only Prisma and the network are mocked. Covers: order→event mapping, gap-only backfill,
// the "already captured → skip" path, and the "server-side off → skip" path.
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import {
  numericId,
  orderToTrackingEvent,
  recordPendingPurchase,
  reconcilePending,
  purchaseValueFromJobs,
} from "../app/lib/reconcile.server.js";

const SHOP = "s.myshopify.com";
const SETTINGS = {
  shopDomain: SHOP,
  serverSide: true,
  reconciliation: true,
  ga4Id: "G-TEST",
  metaPixelId: "111",
  serverSideKeys: JSON.stringify({ ga4ApiSecret: "secret", metaCapiToken: "captoken" }),
  eventMatrix: JSON.stringify({ ga4: ["checkout_completed"], meta: ["checkout_completed"] }),
};

const ORDER = {
  id: 5500000000001,
  created_at: "2026-07-03T10:00:00Z",
  currency: "USD",
  current_total_price: "120.00",
  email: "buyer@example.com",
  customer: { id: 99, email: "buyer@example.com" },
  shipping_address: { first_name: "Sam", last_name: "Jones", city: "Reno", province_code: "NV", zip: "89501", country_code: "US" },
  line_items: [{ title: "Air Max", sku: "AM-9", variant_id: 42, variant_title: "9", product_id: 7, quantity: 2, price: "60.00" }],
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
});

describe("numericId", () => {
  test("extracts the trailing digits from a GID, a number, or returns null", () => {
    expect(numericId("gid://shopify/Order/123456")).toBe("123456");
    expect(numericId(789)).toBe("789");
    expect(numericId("no-digits")).toBe(null);
    expect(numericId(null)).toBe(null);
  });
});

describe("orderToTrackingEvent", () => {
  test("maps a REST order to a checkout_completed event with a deterministic Meta event_id + GA4 txn id", () => {
    const ev = orderToTrackingEvent(ORDER);
    expect(ev.name).toBe("checkout_completed");
    expect(ev.id).toBe("order:5500000000001"); // deterministic Meta event_id
    expect(ev.data.checkout.order.id).toBe("5500000000001"); // GA4 transaction_id source
    expect(ev.data.checkout.totalPrice.amount).toBe(120);
    expect(ev.data.checkout.lineItems[0].variant.sku).toBe("AM-9");
    expect(ev.email).toBe("buyer@example.com");
  });
});

describe("recordPendingPurchase", () => {
  test("stores the pre-built GA4 + Meta jobs (no raw PII — Meta is hashed)", async () => {
    await recordPendingPurchase(SHOP, ORDER, SETTINGS);
    expect(prisma.pendingPurchase.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.pendingPurchase.upsert.mock.calls[0][0];
    const stored = JSON.parse(arg.create.payload);
    expect(stored.ga4.destination).toBe("ga4");
    expect(stored.meta.destination).toBe("meta");
    // The stored Meta job carries only HASHED identifiers, never the raw email.
    expect(JSON.stringify(stored.meta)).not.toContain("buyer@example.com");
    expect(JSON.stringify(stored.meta)).toContain("user_data");
  });

  test("no-op when server-side delivery is off (nothing to backfill to)", async () => {
    await recordPendingPurchase(SHOP, ORDER, { ...SETTINGS, serverSide: false });
    expect(prisma.pendingPurchase.upsert).not.toHaveBeenCalled();
  });
});

describe("reconcilePending", () => {
  const pendingRow = (over = {}) => ({
    shopDomain: SHOP,
    orderId: "5500000000001",
    payload: JSON.stringify({
      ga4: { destination: "ga4", eventName: "checkout_completed", event: { name: "purchase", params: { value: 120 } }, clientId: "1.1" },
      meta: { destination: "meta", eventName: "checkout_completed", event: { event_name: "Purchase" } },
    }),
    status: "pending",
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    ...over,
  });

  test("backfills BOTH destinations when the pixel captured neither", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    prisma.pendingPurchase.findMany.mockResolvedValue([pendingRow()]);
    prisma.purchaseCapture.findUnique.mockResolvedValue(null); // nothing captured client-side

    const summary = await reconcilePending();

    expect(global.fetch).toHaveBeenCalledTimes(2); // GA4 + Meta
    // A fully-missed order → counted as recovered revenue (the order value), and rolled into the daily.
    expect(summary).toMatchObject({ processed: 1, backfilled: 1, ga4: 1, meta: 1, recovered: 1, recoveredValue: 120 });
    expect(prisma.trackingDaily.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ purchasesRecovered: 1, revenueRecovered: 120 }) }),
    );
    expect(prisma.pendingPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "reconciled" }) }),
    );
  });

  test("fills only the GAP: skips a destination the pixel already delivered", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    prisma.pendingPurchase.findMany.mockResolvedValue([pendingRow()]);
    prisma.purchaseCapture.findUnique.mockResolvedValue({ shopDomain: SHOP, orderId: "5500000000001", ga4: true, meta: false });

    const summary = await reconcilePending();

    expect(global.fetch).toHaveBeenCalledTimes(1); // GA4 already captured → only Meta sent
    expect(global.fetch.mock.calls[0][0]).toContain("graph.facebook.com");
    // A partial backfill (the pixel already captured GA4) is NOT counted as recovered revenue — that
    // would double it against the pixel's own capture.
    expect(summary).toMatchObject({ backfilled: 1, meta: 1, ga4: 0, recovered: 0, recoveredValue: 0 });
    expect(prisma.trackingDaily.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ purchasesRecovered: 1 }) }),
    );
  });

  test("skips (no send) when both destinations were already captured", async () => {
    global.fetch = jest.fn();
    prisma.pendingPurchase.findMany.mockResolvedValue([pendingRow()]);
    prisma.purchaseCapture.findUnique.mockResolvedValue({ ga4: true, meta: true });

    const summary = await reconcilePending();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ processed: 1, backfilled: 0, skipped: 1 });
    expect(prisma.pendingPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "skipped" }) }),
    );
  });

  afterEach(() => (global.fetch = undefined));
});

describe("purchaseValueFromJobs", () => {
  test("reads the GA4 value first, falls back to Meta, else 0", () => {
    expect(purchaseValueFromJobs({ ga4: { event: { params: { value: 120 } } } })).toBe(120);
    expect(purchaseValueFromJobs({ meta: { event: { custom_data: { value: 80 } } } })).toBe(80);
    expect(purchaseValueFromJobs({})).toBe(0);
    expect(purchaseValueFromJobs(null)).toBe(0);
  });
});
