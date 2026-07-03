/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// Integration test for the durable-retry state machine (outbox.server.drainOutbox). Exercises the REAL
// deliverOne → sendGa4 → fetch path so a queued job is re-sent byte-identically; only Prisma and the
// network (fetch) are mocked. Covers the three terminal transitions: delivered / requeued / dead-letter.
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { drainOutbox, BACKOFF_MINUTES, MAX_ATTEMPTS } from "../app/lib/outbox.server.js";

// A shop with GA4 configured (plaintext keys — decryptSecret passes non-"enc:" values through unchanged).
const SETTINGS = { shopDomain: "s.myshopify.com", ga4Id: "G-TEST", serverSideKeys: JSON.stringify({ ga4ApiSecret: "secret" }) };

// One pending GA4 job row, `attempts` already spent.
const row = (attempts, id = "row1") => ({
  id,
  shopDomain: SETTINGS.shopDomain,
  destination: "ga4",
  eventName: "purchase",
  payload: JSON.stringify({ event: { name: "purchase", params: { value: 10 } }, clientId: "1.1", consent: null }),
  attempts,
  status: "pending",
  nextAttemptAt: new Date(Date.now() - 1000),
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.trackingSettings.findUnique.mockResolvedValue(SETTINGS);
});

test("delivered: a job that now succeeds is marked delivered and hits the GA4 endpoint", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  prisma.deliveryOutbox.findMany.mockResolvedValue([row(1)]);

  const summary = await drainOutbox();

  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][0]).toContain("google-analytics.com/mp/collect");
  expect(prisma.deliveryOutbox.update).toHaveBeenCalledWith(
    // The terminal transition clears the lease token so a finished row never carries a dangling one.
    expect.objectContaining({ where: { id: "row1" }, data: expect.objectContaining({ status: "delivered", leaseToken: null }) }),
  );
  expect(summary).toMatchObject({ processed: 1, delivered: 1, requeued: 0, dead: 0 });
});

test("requeued: a transient failure bumps attempts and schedules the next backoff (not dead yet)", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
  prisma.deliveryOutbox.findMany.mockResolvedValue([row(1)]); // 1 attempt spent → next is BACKOFF_MINUTES[1]

  const before = Date.now();
  const summary = await drainOutbox();

  const call = prisma.deliveryOutbox.update.mock.calls[0][0];
  expect(call.where).toEqual({ id: "row1" });
  expect(call.data.attempts).toBe(2);
  expect(call.data.status).toBeUndefined(); // still pending
  // nextAttemptAt is ~BACKOFF_MINUTES[1] (5m) in the future.
  const delayMin = (new Date(call.data.nextAttemptAt).getTime() - before) / 60000;
  expect(delayMin).toBeGreaterThan(BACKOFF_MINUTES[1] - 0.5);
  expect(delayMin).toBeLessThan(BACKOFF_MINUTES[1] + 0.5);
  expect(summary).toMatchObject({ processed: 1, delivered: 0, requeued: 1, dead: 0 });
});

test("dead-letter: the final failed attempt marks the row dead (no further retries)", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
  // MAX_ATTEMPTS-1 spent → this failure is the last one, so attempts hits MAX_ATTEMPTS → dead.
  prisma.deliveryOutbox.findMany.mockResolvedValue([row(MAX_ATTEMPTS - 1)]);

  const summary = await drainOutbox();

  expect(prisma.deliveryOutbox.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "dead", attempts: MAX_ATTEMPTS }) }),
  );
  expect(summary).toMatchObject({ processed: 1, delivered: 0, requeued: 0, dead: 1 });
});

test("a shop whose settings vanished doesn't crash — the row is retried later", async () => {
  global.fetch = jest.fn();
  prisma.trackingSettings.findUnique.mockResolvedValue(null); // uninstalled mid-flight
  prisma.deliveryOutbox.findMany.mockResolvedValue([row(1)]);

  const summary = await drainOutbox();

  expect(global.fetch).not.toHaveBeenCalled(); // deliverOne never attempted without settings
  expect(summary).toMatchObject({ processed: 1, delivered: 0, requeued: 1 });
});

test("a recovered purchase stamps PurchaseCapture so reconcile won't re-send it", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  // A queued Meta Purchase for order 5500000000001 (event_id order-scoped, as the builder now emits).
  const metaRow = {
    id: "rowM",
    shopDomain: SETTINGS.shopDomain,
    destination: "meta",
    eventName: "checkout_completed",
    payload: JSON.stringify({ event: { event_name: "Purchase", event_id: "order:5500000000001", custom_data: { order_id: "5500000000001", value: 120 } } }),
    attempts: 1,
    status: "pending",
    nextAttemptAt: new Date(Date.now() - 1000),
  };
  prisma.trackingSettings.findUnique.mockResolvedValue({ ...SETTINGS, metaPixelId: "PIX", serverSideKeys: JSON.stringify({ metaCapiToken: "tok" }) });
  prisma.deliveryOutbox.findMany.mockResolvedValue([metaRow]);

  await drainOutbox();

  expect(prisma.purchaseCapture.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { shopDomain_orderId: { shopDomain: SETTINGS.shopDomain, orderId: "5500000000001" } },
      update: expect.objectContaining({ meta: true }),
    }),
  );
});

test("nothing due → a clean no-op summary", async () => {
  prisma.deliveryOutbox.findMany.mockResolvedValue([]);
  expect(await drainOutbox()).toMatchObject({ processed: 0, delivered: 0, requeued: 0, dead: 0 });
});

test("a corrupt/undecryptable payload is dead-lettered, not sent as garbage-then-delivered", async () => {
  global.fetch = jest.fn();
  // decryptSecret passes a non-"enc:" value through unchanged; this isn't valid JSON → parse fails.
  prisma.deliveryOutbox.findMany.mockResolvedValue([{ ...row(1), payload: "not valid json {" }]);

  const summary = await drainOutbox();

  expect(global.fetch).not.toHaveBeenCalled(); // never posts {events:[undefined]}
  expect(prisma.deliveryOutbox.update).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "row1" }, data: expect.objectContaining({ status: "dead" }) }),
  );
  expect(summary).toMatchObject({ processed: 1, delivered: 0, dead: 1 });
});

test("leases the batch with a compare-and-swap token before processing", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  prisma.deliveryOutbox.findMany.mockResolvedValue([row(1)]);

  await drainOutbox();

  // The lease updateMany stamps a token and only touches rows still due (nextAttemptAt <= now).
  expect(prisma.deliveryOutbox.updateMany).toHaveBeenCalledTimes(1);
  const lease = prisma.deliveryOutbox.updateMany.mock.calls[0][0];
  expect(lease.data.leaseToken).toEqual(expect.any(String));
  expect(lease.data.leaseToken.length).toBeGreaterThan(0);
  expect(lease.where.nextAttemptAt).toEqual({ lte: expect.any(Date) });
  // The rows to process are re-selected by that same token.
  expect(prisma.deliveryOutbox.findMany.mock.calls[1][0].where.leaseToken).toBe(lease.data.leaseToken);
});

test("concurrency: rows won by another tick (empty claim re-query) are not processed or re-sent", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  // First findMany = the due batch; second findMany = rows carrying OUR token → empty, because a
  // concurrent tick leased them first (its lease pushed nextAttemptAt out, so our CAS matched nothing).
  prisma.deliveryOutbox.findMany.mockResolvedValueOnce([row(1)]).mockResolvedValueOnce([]);

  const summary = await drainOutbox();

  expect(global.fetch).not.toHaveBeenCalled(); // nothing re-sent
  expect(prisma.deliveryOutbox.update).not.toHaveBeenCalled(); // no status transition on rows we don't own
  expect(summary).toMatchObject({ processed: 0, delivered: 0, requeued: 0, dead: 0 });
});
