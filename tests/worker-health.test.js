/* eslint-disable import/first -- jest.mock() must precede the imports it intercepts */
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { recordTick, getHeartbeat } from "../app/lib/heartbeat.server.js";
import { computeHealth, dismissAlert } from "../app/lib/health.server.js";

beforeEach(() => jest.clearAllMocks());

describe("heartbeat.server", () => {
  test("a tick upserts the single global row with its job summary", async () => {
    await recordTick({ durationMs: 1234.6, jobs: { outbox: { delivered: 2 } } });
    const call = prisma.cronHeartbeat.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ scope: "_global" });
    expect(call.update.durationMs).toBe(1235); // rounded
    expect(JSON.parse(call.update.jobs)).toEqual({ outbox: { delivered: 2 } });
    expect(call.update.errors).toBeNull();
  });

  test("an errored tick is still recorded, so a failing worker reads as failing not stale", async () => {
    await recordTick({ durationMs: 10, errors: [{ job: "tick", message: "boom" }] });
    const call = prisma.cronHeartbeat.upsert.mock.calls[0][0];
    expect(JSON.parse(call.update.errors)).toEqual([{ job: "tick", message: "boom" }]);
  });

  test("a negative duration can never be written", async () => {
    await recordTick({ durationMs: -5 });
    expect(prisma.cronHeartbeat.upsert.mock.calls[0][0].update.durationMs).toBe(0);
  });

  test("recording is best-effort — a DB failure must not fail the cron tick", async () => {
    prisma.cronHeartbeat.upsert.mockRejectedValue(new Error("db down"));
    await expect(recordTick({ durationMs: 1 })).resolves.toBeUndefined();
  });

  test("getHeartbeat resolves null rather than throwing when the DB is down", async () => {
    prisma.cronHeartbeat.findUnique.mockRejectedValue(new Error("db down"));
    await expect(getHeartbeat()).resolves.toBeNull();
  });
});

describe("health.server", () => {
  const daily = (o) => ({ ordersPaid: 0, purchasesDelivered: 0, eventsSent: 0, eventsFailed: 0, ...o });

  test("sums the daily rows and evaluates them into alerts", async () => {
    prisma.trackingDaily.findMany.mockResolvedValue([daily({ ordersPaid: 50, purchasesDelivered: 50, eventsSent: 100 })]);
    const health = await computeHealth("s.myshopify.com");
    expect(health).toHaveProperty("alerts");
    expect(Array.isArray(health.alerts)).toBe(true);
  });

  test("a fresh install with no heartbeat raises no cron_stale alarm", async () => {
    prisma.cronHeartbeat.findUnique.mockResolvedValue(null);
    const health = await computeHealth("s.myshopify.com");
    expect(health.alerts.some((a) => a.kind === "cron_stale")).toBe(false);
  });

  test("a recently dismissed alert is suppressed, an old dismissal re-arms", async () => {
    // Force a real alert: paid orders with nothing delivered is unambiguous.
    prisma.trackingDaily.findMany.mockResolvedValue([daily({ ordersPaid: 100, purchasesDelivered: 0 })]);
    const undismissed = await computeHealth("s.myshopify.com");
    const kind = undismissed.alerts[0]?.kind;
    expect(kind).toBeTruthy();

    prisma.alertDismissal.findMany.mockResolvedValue([{ kind, dismissedAt: new Date() }]);
    const dismissed = await computeHealth("s.myshopify.com");
    expect(dismissed.alerts.some((a) => a.kind === kind)).toBe(false);

    // Older than the 7-day re-arm window → it comes back, because the condition still holds.
    prisma.alertDismissal.findMany.mockResolvedValue([{ kind, dismissedAt: new Date(Date.now() - 30 * 864e5) }]);
    const rearmed = await computeHealth("s.myshopify.com");
    expect(rearmed.alerts.some((a) => a.kind === kind)).toBe(true);
  });

  test("failing connection checks are carried into the metrics", async () => {
    prisma.connectionCheck.findMany.mockResolvedValue([{ destination: "ga4", detail: "401" }]);
    const health = await computeHealth("s.myshopify.com");
    expect(health).toBeTruthy();
    expect(prisma.connectionCheck.findMany).toHaveBeenCalledWith({ where: { shopDomain: "s.myshopify.com", ok: false } });
  });

  test("dismissAlert upserts, and ignores a missing shop or kind", async () => {
    await dismissAlert("s.myshopify.com", "delivery_failures");
    expect(prisma.alertDismissal.upsert).toHaveBeenCalled();
    jest.clearAllMocks();
    await dismissAlert("s.myshopify.com", null);
    await dismissAlert(null, "x");
    expect(prisma.alertDismissal.upsert).not.toHaveBeenCalled();
  });
});
