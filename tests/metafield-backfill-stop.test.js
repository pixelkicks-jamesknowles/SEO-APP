/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// Stop / resume for the "Write attribution into Shopify's reporting" run.
//
// The interesting case is NOT "does the button set a flag" — it's whether a tick that is already mid-flight
// can undo the stop. That tick finishes its batch and then writes the row back with `status: "running"`, so
// if the stop didn't invalidate its lease the job would silently resurrect itself and keep stamping.
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));
jest.mock("../app/shopify.server.js", () => ({ __esModule: true, unauthenticated: { admin: jest.fn() } }));
jest.mock("../app/lib/report-writeback.server.js", () => ({
  __esModule: true,
  writeOrderAttribution: jest.fn(async () => ({ ok: true })),
  writeCustomerAttribution: jest.fn(async () => ({ ok: true })),
  attributionValues: jest.fn(() => ({})),
}));

import prisma from "../app/db.server.js";
import { cancelMetafieldBackfill, resumeMetafieldBackfill, processMetafieldBackfill, requestMetafieldBackfill, metafieldBackfillStatus } from "../app/lib/metafield-backfill.server.js";
import { unauthenticated } from "../app/shopify.server.js";
import { writeOrderAttribution } from "../app/lib/report-writeback.server.js";

const SHOP = "s.myshopify.com";
beforeEach(() => jest.clearAllMocks());

describe("cancelMetafieldBackfill", () => {
  test("stops the job and clears the lease, keeping progress + cursor for a resume", async () => {
    prisma.metafieldBackfillJob.updateMany.mockResolvedValue({ count: 1 });

    expect(await cancelMetafieldBackfill(SHOP)).toEqual({ stopped: true });

    const call = prisma.metafieldBackfillJob.updateMany.mock.calls[0][0];
    // Only a RUNNING job can be stopped — stopping a finished one must not rewrite its outcome.
    expect(call.where).toEqual({ shopDomain: SHOP, status: "running" });
    expect(call.data.status).toBe("cancelled");
    // Clearing the lease is what makes an in-flight tick harmless: every write it performs is scoped to
    // `leaseToken: <its token>`, so once the token is gone none of them match — including the terminal one
    // that would set the row back to "running".
    expect(call.data.leaseToken).toBeNull();
    expect(call.data.leasedUntil).toBeNull();
    // Progress and cursor are deliberately NOT reset, so Resume doesn't re-walk the whole history.
    expect(call.data).not.toHaveProperty("cursor");
    expect(call.data).not.toHaveProperty("ordersProcessed");
    expect(call.data).not.toHaveProperty("metafieldsWritten");
  });

  test("reports stopped:false when nothing was running", async () => {
    prisma.metafieldBackfillJob.updateMany.mockResolvedValue({ count: 0 });
    expect(await cancelMetafieldBackfill(SHOP)).toEqual({ stopped: false });
  });

  test("never throws — a stop that fails must not break the page", async () => {
    prisma.metafieldBackfillJob.updateMany.mockRejectedValue(new Error("db down"));
    await expect(cancelMetafieldBackfill(SHOP)).resolves.toEqual({ stopped: false });
  });
});

describe("resumeMetafieldBackfill", () => {
  test("flips a stopped job back to running WITHOUT resetting the cursor", async () => {
    prisma.metafieldBackfillJob.updateMany.mockResolvedValue({ count: 1 });

    expect(await resumeMetafieldBackfill(SHOP)).toEqual({ resumed: true });

    const call = prisma.metafieldBackfillJob.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ shopDomain: SHOP, status: "cancelled" });
    expect(call.data.status).toBe("running");
    // The whole point of resume vs. start-over: keep the saved cursor so a 60k-order history isn't
    // re-walked from the top.
    expect(call.data).not.toHaveProperty("cursor");
    // finishedAt is cleared, or the card would still read as a completed run.
    expect(call.data.finishedAt).toBeNull();
  });

  test("only resumes a cancelled job — a running or done one is left alone", async () => {
    prisma.metafieldBackfillJob.updateMany.mockResolvedValue({ count: 0 });
    expect(await resumeMetafieldBackfill(SHOP)).toEqual({ resumed: false });
    expect(prisma.metafieldBackfillJob.updateMany.mock.calls[0][0].where.status).toBe("cancelled");
  });

  test("never throws", async () => {
    prisma.metafieldBackfillJob.updateMany.mockRejectedValue(new Error("db down"));
    await expect(resumeMetafieldBackfill(SHOP)).resolves.toEqual({ resumed: false });
  });
});

// The worker side of Stop. These cover the behaviour that actually makes the button work: a tick already
// in flight has to notice the status change and stop writing, and must not resurrect the row afterwards.
describe("processMetafieldBackfill — stop handling", () => {
  const page = (hasNextPage) => ({
    json: async () => ({
      data: {
        orders: {
          nodes: [{ id: "gid://shopify/Order/1", createdAt: "2026-01-01T00:00:00Z", customer: { id: "gid://shopify/Customer/9" }, lineItems: { nodes: [] } }],
          pageInfo: { hasNextPage, endCursor: "cur" },
        },
      },
    }),
  });

  const claimJob = () => {
    prisma.metafieldBackfillJob.findFirst.mockResolvedValue({ shopDomain: SHOP, cursor: null, ordersProcessed: 0, metafieldsWritten: 0, historySince: "2024-01-01" });
    prisma.metafieldBackfillJob.updateMany.mockResolvedValue({ count: 1 }); // lease claimed
  };

  test("an in-flight tick bails as soon as the job is no longer running", async () => {
    claimJob();
    // The per-page liveness read: the merchant pressed Stop, so the row now reads "cancelled".
    prisma.metafieldBackfillJob.findUnique.mockResolvedValue({ status: "cancelled" });
    const graphql = jest.fn(async () => page(true));
    unauthenticated.admin.mockResolvedValue({ admin: { graphql } });

    const res = await processMetafieldBackfill();

    // It stopped BEFORE fetching or writing anything — that is the point of checking at the top of the page.
    expect(graphql).not.toHaveBeenCalled();
    expect(writeOrderAttribution).not.toHaveBeenCalled();
    expect(res.cancelled).toBe(true);
    expect(res.done).toBe(false); // a cancelled run must never be recorded as completed
  });

  test("keeps going while the job is still running", async () => {
    claimJob();
    prisma.metafieldBackfillJob.findUnique.mockResolvedValue({ status: "running" });
    const graphql = jest.fn(async () => page(false)); // single page, then finished
    unauthenticated.admin.mockResolvedValue({ admin: { graphql } });

    const res = await processMetafieldBackfill();

    expect(graphql).toHaveBeenCalled();
    expect(writeOrderAttribution).toHaveBeenCalled();
    expect(res.done).toBe(true);
    expect(res.cancelled).toBeUndefined();
  });

  test("every write the tick makes is lease-scoped, so a stop cannot be undone", async () => {
    claimJob();
    prisma.metafieldBackfillJob.findUnique.mockResolvedValue({ status: "running" });
    unauthenticated.admin.mockResolvedValue({ admin: { graphql: jest.fn(async () => page(false)) } });

    await processMetafieldBackfill();

    // Ignore the initial lease claim; every subsequent write must be scoped to this tick's leaseToken.
    // cancelMetafieldBackfill nulls that token, so once stopped none of these can match the row.
    const writes = prisma.metafieldBackfillJob.updateMany.mock.calls.slice(1).map((c) => c[0].where);
    expect(writes.length).toBeGreaterThan(0);
    for (const where of writes) expect(where).toHaveProperty("leaseToken");
  });

  test("does nothing when no job is running", async () => {
    prisma.metafieldBackfillJob.findFirst.mockResolvedValue(null);
    expect(await processMetafieldBackfill()).toEqual({ ran: 0 });
  });
});

describe("requestMetafieldBackfill", () => {
  test("starts a fresh run from the top, clearing cursor and counters", async () => {
    prisma.metafieldBackfillJob.findUnique.mockResolvedValue(null);
    expect(await requestMetafieldBackfill(SHOP)).toEqual({ queued: true });

    const { create } = prisma.metafieldBackfillJob.upsert.mock.calls[0][0];
    expect(create.status).toBe("running");
    expect(create.cursor).toBeNull(); // start-over semantics, unlike resume
    expect(create.ordersProcessed).toBe(0);
    expect(create.metafieldsWritten).toBe(0);
  });

  test("leaves an already-running job alone rather than restarting it", async () => {
    prisma.metafieldBackfillJob.findUnique.mockResolvedValue({ status: "running" });
    expect(await requestMetafieldBackfill(SHOP)).toEqual({ queued: false, detail: "already running" });
    expect(prisma.metafieldBackfillJob.upsert).not.toHaveBeenCalled();
  });

  test("a stopped job CAN be restarted (it is not 'running')", async () => {
    prisma.metafieldBackfillJob.findUnique.mockResolvedValue({ status: "cancelled" });
    expect(await requestMetafieldBackfill(SHOP)).toEqual({ queued: true });
  });
});

describe("metafieldBackfillStatus", () => {
  test("returns the row, and null rather than throwing when the read fails", async () => {
    prisma.metafieldBackfillJob.findUnique.mockResolvedValue({ shopDomain: SHOP, status: "cancelled" });
    expect(await metafieldBackfillStatus(SHOP)).toEqual({ shopDomain: SHOP, status: "cancelled" });

    prisma.metafieldBackfillJob.findUnique.mockRejectedValue(new Error("db down"));
    await expect(metafieldBackfillStatus(SHOP)).resolves.toBeNull();
  });
});

describe("processMetafieldBackfill — claim + failure handling", () => {
  test("backs off when another tick won the lease", async () => {
    prisma.metafieldBackfillJob.findFirst.mockResolvedValue({ shopDomain: SHOP });
    prisma.metafieldBackfillJob.updateMany.mockResolvedValue({ count: 0 }); // lost the race
    expect(await processMetafieldBackfill()).toEqual({ ran: 0 });
  });

  test("a TRANSIENT Admin failure pauses the job as still-running, not errored", async () => {
    // Marking it `error` here is what once turned a momentary Shopify 502 into a permanent
    // "Write-back failed" banner that only a manual re-run could clear.
    prisma.metafieldBackfillJob.findFirst.mockResolvedValue({ shopDomain: SHOP, cursor: null, ordersProcessed: 0, metafieldsWritten: 0 });
    prisma.metafieldBackfillJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.metafieldBackfillJob.findUnique.mockResolvedValue({ status: "running" });
    unauthenticated.admin.mockRejectedValue(Object.assign(new Error("Bad Gateway"), { networkStatusCode: 502 }));

    const res = await processMetafieldBackfill();

    expect(res.retrying).toBeDefined();
    expect(res.error).toBeUndefined();
    const last = prisma.metafieldBackfillJob.updateMany.mock.calls.at(-1)[0].data;
    expect(last.status).toBe("running");
    expect(last.leaseToken).toBeNull(); // lease dropped so the next tick can pick it up
  });

  test("a TERMINAL failure (missing scope) marks the job errored", async () => {
    prisma.metafieldBackfillJob.findFirst.mockResolvedValue({ shopDomain: SHOP, cursor: null, ordersProcessed: 0, metafieldsWritten: 0 });
    prisma.metafieldBackfillJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.metafieldBackfillJob.findUnique.mockResolvedValue({ status: "running" });
    unauthenticated.admin.mockRejectedValue(Object.assign(new Error("Access denied"), { networkStatusCode: 403 }));

    const res = await processMetafieldBackfill();

    expect(res.error).toBeDefined();
    expect(prisma.metafieldBackfillJob.updateMany.mock.calls.at(-1)[0].data.status).toBe("error");
  });
});

describe("processMetafieldBackfill — page-level error handling", () => {
  const claimed = () => {
    prisma.metafieldBackfillJob.findFirst.mockResolvedValue({ shopDomain: SHOP, cursor: null, ordersProcessed: 0, metafieldsWritten: 0 });
    prisma.metafieldBackfillJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.metafieldBackfillJob.findUnique.mockResolvedValue({ status: "running" });
  };
  const errorPage = (message, extensions) => ({ json: async () => ({ errors: [{ message, ...(extensions ? { extensions } : {}) }] }) });

  test("a THROTTLED page banks progress and resumes next tick instead of failing", async () => {
    claimed();
    unauthenticated.admin.mockResolvedValue({ admin: { graphql: jest.fn(async () => errorPage("Throttled")) } });

    const res = await processMetafieldBackfill();

    // Not an error, and not done — it simply stops early and the saved cursor carries it forward.
    expect(res.error).toBeUndefined();
    expect(res.done).toBe(false);
  });

  test("a missing-scope page fails with an actionable message naming the scopes", async () => {
    claimed();
    unauthenticated.admin.mockResolvedValue({ admin: { graphql: jest.fn(async () => errorPage("Access denied for orders field")) } });

    const res = await processMetafieldBackfill();

    expect(res.error).toMatch(/read_all_orders/);
    expect(res.error).toMatch(/write_orders/);
  });

  test("seeds the first-touch lookup under BOTH the stored key and its numeric id", async () => {
    // CustomerAttribution keys are a GID from the backfill but a bare id from the live path, so the
    // lookup has to answer to either or historical orders silently get no attribution stamped.
    claimed();
    prisma.customerAttribution.findMany.mockResolvedValue([
      { customerKey: "gid://shopify/Customer/9", source: "google", medium: "cpc", firstOrderId: "1" },
    ]);
    unauthenticated.admin.mockResolvedValue({
      admin: {
        graphql: jest.fn(async () => ({
          json: async () => ({
            data: {
              orders: {
                nodes: [{ id: "gid://shopify/Order/1", createdAt: "2026-01-01T00:00:00Z", customer: { id: "9" }, lineItems: { nodes: [] } }],
                pageInfo: { hasNextPage: false, endCursor: "c" },
              },
            },
          }),
        })),
      },
    });

    const res = await processMetafieldBackfill();

    // The order's bare customer id "9" matched the GID-keyed row, so the order was stamped.
    expect(writeOrderAttribution).toHaveBeenCalled();
    expect(res.done).toBe(true);
  });
});
