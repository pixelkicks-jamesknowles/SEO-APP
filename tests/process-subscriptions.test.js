/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// processPendingSubscriptions is the DEFERRED orders/paid conversion pipeline — the heavy work (Admin
// selling-plan lookup, consent gating, attribution, the subscription_purchase + purchase GA4 sends,
// outbox-on-failure, capture stamping) that used to run inline in the webhook. It's leased like the
// reconcile pass so overlapping cron ticks can't double-send. Only Prisma, HMAC auth and the Admin-API
// selling-plan lookup are mocked; the real pure builders + sendGa4Event → fetch path run.
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
import { processPendingSubscriptions, processSubscriptionNow, recordPendingSubscription } from "../app/lib/subscription-cron.server.js";

const SHOP = "s.myshopify.com";
const gaCalls = () => (global.fetch?.mock?.calls || []).filter((c) => String(c[0]).includes("google-analytics.com"));

const SETTINGS = {
  shopDomain: SHOP,
  serverSide: true,
  subscriptionTracking: true,
  valueMode: "revenue",
  fxMode: "off",
  ga4Id: "G-TEST",
  serverSideKeys: JSON.stringify({ ga4ApiSecret: "s" }),
  subscriptionConfig: "{}",
};

// A subscription order (a line carries a selling_plan_allocation → orderHasSubscription is true even with
// an empty Admin lookup, matching what the webhook grafts on).
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

// A recorded PendingSubscription row. payload is stored plaintext here (decryptSecret reads legacy
// plaintext back unchanged), mirroring the reconcile test's fixtures.
const pendingRow = (order = subOrder()) => ({ shopDomain: SHOP, orderId: "5500000000009", payload: JSON.stringify(order), status: "pending" });

const run = () => processPendingSubscriptions({ limit: 6 });

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  prisma.pendingSubscription.findMany.mockResolvedValue([pendingRow()]);
  prisma.customerAttribution.findUnique.mockResolvedValue(null); // first order for this customer
  prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
});

describe("processPendingSubscriptions — deferred conversion pipeline", () => {
  test("a subscription order sends BOTH GA4 events (subscription_purchase + purchase), stamps GA4 capture, and closes the row", async () => {
    const summary = await run();

    expect(gaCalls()).toHaveLength(2);
    expect(summary).toMatchObject({ processed: 1, sent: 1 });
    // GA4 capture stamped so the reconcile pass won't re-send the purchase we just delivered.
    expect(prisma.purchaseCapture.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain_orderId: { shopDomain: SHOP, orderId: "5500000000009" } },
        update: expect.objectContaining({ ga4: true }),
      }),
    );
    // Row closed (done) with the lease cleared.
    const upd = prisma.pendingSubscription.update.mock.calls.at(-1)[0];
    expect(upd.data).toMatchObject({ status: "done", leaseToken: null, leasedUntil: null });
  });

  test("a failed GA4 send is queued to the durable outbox and does NOT stamp capture", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    const summary = await run();

    expect(prisma.deliveryOutbox.create).toHaveBeenCalledTimes(2); // both sends queued for retry
    expect(prisma.purchaseCapture.upsert).not.toHaveBeenCalled(); // nothing delivered → no capture
    expect(summary).toMatchObject({ failed: 1 });
    // Still closed — the outbox now owns the retry, so re-running the pipeline would duplicate records.
    expect(prisma.pendingSubscription.update.mock.calls.at(-1)[0].data.status).toBe("done");
  });

  test("a non-subscription order sends nothing and is marked skipped", async () => {
    prisma.pendingSubscription.findMany.mockResolvedValue([pendingRow(subOrder({ line_items: [{ id: 1, sku: "OneOff", title: "Mug", price: "20.00", quantity: 1 }] }))]);

    const summary = await run();

    expect(gaCalls()).toHaveLength(0);
    expect(summary).toMatchObject({ skipped: 1 });
    expect(prisma.pendingSubscription.update.mock.calls.at(-1)[0].data.status).toBe("skipped");
  });

  test("strict consent (consentMode on, signals off, no marketing consent) hard-drops the send", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, consentMode: true, consentSignals: false });
    prisma.pendingSubscription.findMany.mockResolvedValue([pendingRow(subOrder({ buyer_accepts_marketing: false }))]);

    await run();

    expect(gaCalls()).toHaveLength(0);
  });

  test("subscription tracking turned OFF between record and process: the row is skipped, not sent", async () => {
    prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, subscriptionTracking: false });

    const summary = await run();

    expect(gaCalls()).toHaveLength(0);
    expect(summary).toMatchObject({ skipped: 1 });
  });

  test("leases the batch (compare-and-swap) then processes only the rows carrying its token", async () => {
    await run();

    const lease = prisma.pendingSubscription.updateMany.mock.calls[0][0];
    expect(lease.data.leaseToken).toEqual(expect.any(String));
    expect(lease.data.leaseToken.length).toBeGreaterThan(0);
    // The claimed re-select is filtered by exactly the token we just stamped.
    expect(prisma.pendingSubscription.findMany.mock.calls[1][0].where.leaseToken).toBe(lease.data.leaseToken);
  });

  test("no pending rows → a clean no-op summary", async () => {
    prisma.pendingSubscription.findMany.mockResolvedValue([]);

    const summary = await run();

    expect(summary).toEqual({ processed: 0, sent: 0, skipped: 0, failed: 0 });
    expect(gaCalls()).toHaveLength(0);
  });
});

describe("recordPendingSubscription", () => {
  test("upserts the order encrypted, and a redelivery must not reopen the row", async () => {
    await recordPendingSubscription(SHOP, subOrder());

    const arg = prisma.pendingSubscription.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ shopDomain_orderId: { shopDomain: SHOP, orderId: "5500000000009" } });
    expect(arg.create.payload).toMatch(/^enc:v1:/); // encrypted at rest, not plaintext JSON
    expect(arg.update).toEqual({}); // redelivery no-op
  });
});

describe("processSubscriptionNow — immediate (webhook-kicked) delivery", () => {
  test("claims the row's lease (CAS), delivers both GA4 events, stamps capture, and closes the row", async () => {
    prisma.pendingSubscription.updateMany.mockResolvedValue({ count: 1 }); // we win the lease

    const outcome = await processSubscriptionNow(SHOP, subOrder(), { settings: SETTINGS });

    expect(outcome).toBe("sent");
    expect(gaCalls()).toHaveLength(2);
    // Leased before processing so the cron backstop can't also send it.
    const lease = prisma.pendingSubscription.updateMany.mock.calls[0][0];
    expect(lease.where).toMatchObject({ shopDomain: SHOP, orderId: "5500000000009", status: "pending" });
    expect(lease.data.leaseToken).toEqual(expect.any(String));
    expect(prisma.purchaseCapture.upsert).toHaveBeenCalled();
    expect(prisma.pendingSubscription.update.mock.calls.at(-1)[0].data).toMatchObject({ status: "done", leaseToken: null });
  });

  test("no-ops without sending when the row is already owned (cron beat it to the lease)", async () => {
    prisma.pendingSubscription.updateMany.mockResolvedValue({ count: 0 }); // someone else holds the lease

    const outcome = await processSubscriptionNow(SHOP, subOrder(), { settings: SETTINGS });

    expect(outcome).toBe("busy");
    expect(gaCalls()).toHaveLength(0); // never processed → never double-sends against the cron backstop
    expect(prisma.pendingSubscription.update).not.toHaveBeenCalled(); // didn't own the row, so didn't settle it
  });

  test("a non-subscription order it owns is delivered nowhere and closed as skipped", async () => {
    prisma.pendingSubscription.updateMany.mockResolvedValue({ count: 1 });

    const outcome = await processSubscriptionNow(SHOP, subOrder({ line_items: [{ id: 1, sku: "OneOff", title: "Mug", price: "20.00", quantity: 1 }] }), { settings: SETTINGS });

    expect(outcome).toBe("skipped");
    expect(gaCalls()).toHaveLength(0);
    expect(prisma.pendingSubscription.update.mock.calls.at(-1)[0].data.status).toBe("skipped");
  });
});
