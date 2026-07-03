/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// Integration test for the shared storefront-event ingest path (ingest.server.ingestEvent). Runs the
// REAL bot filter, first-touch capture, fan-out (buildJobs → deliverOne → fetch), delivery recording and
// failure-enqueue; only Prisma and fetch are mocked. This is the hot path every storefront hit takes.
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { ingestEvent } from "../app/lib/ingest.server.js";

const SHOP = "s.myshopify.com";

// serverSide on, GA4 + Meta configured, both events opted in for both platforms.
const baseSettings = () => ({
  shopDomain: SHOP,
  serverSide: true,
  botFiltering: true,
  consentMode: true,
  consentSignals: true,
  fxMode: "off",
  googleAdsEnabled: false,
  valueMode: "revenue",
  ga4Id: "G-TEST",
  metaPixelId: "PIX-1",
  serverSideKeys: JSON.stringify({ ga4ApiSecret: "s", metaCapiToken: "t" }),
  eventMatrix: JSON.stringify({ ga4: ["page_viewed", "checkout_completed"], meta: ["page_viewed", "checkout_completed"] }),
});

const gaCalls = () => global.fetch.mock.calls.filter((c) => String(c[0]).includes("google-analytics.com"));
const metaCalls = () => global.fetch.mock.calls.filter((c) => String(c[0]).includes("graph.facebook.com"));

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  prisma.trackingSettings.findUnique.mockResolvedValue(baseSettings());
});

test("unknown shop → ignored (no buffering, no delivery)", async () => {
  prisma.trackingSettings.findUnique.mockResolvedValue(null);
  await ingestEvent("nope.myshopify.com", { event: { name: "page_viewed" } }, "1.2.3.4");
  expect(prisma.recentEvent.create).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("empty body → ignored", async () => {
  await ingestEvent(SHOP, null, undefined);
  await ingestEvent(SHOP, { event: null }, undefined);
  expect(prisma.trackingSettings.findUnique).not.toHaveBeenCalled();
});

test("bot traffic is dropped before it is buffered or delivered", async () => {
  await ingestEvent(SHOP, { event: { name: "page_viewed", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" } }, "1.2.3.4");
  expect(prisma.recentEvent.create).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("bot filtering off → a bot UA is still delivered", async () => {
  prisma.trackingSettings.findUnique.mockResolvedValue({ ...baseSettings(), botFiltering: false });
  await ingestEvent(SHOP, { event: { name: "page_viewed", userAgent: "Googlebot/2.1", clientId: "1.1" } }, undefined);
  expect(gaCalls()).toHaveLength(1);
});

test("happy path: a real event is buffered and fanned out to GA4", async () => {
  await ingestEvent(SHOP, { event: { name: "page_viewed", clientId: "1.1", userAgent: "Mozilla/5.0 Chrome/120" } }, "1.2.3.4");
  expect(prisma.recentEvent.create).toHaveBeenCalledTimes(1);
  expect(gaCalls()).toHaveLength(1);
  expect(prisma.deliveryLog.createMany).toHaveBeenCalledTimes(1); // recordDeliveries
  expect(prisma.deliveryOutbox.create).not.toHaveBeenCalled(); // nothing failed → nothing queued
});

test("consent gating: analytics-yes / marketing-no delivers GA4 but skips Meta", async () => {
  await ingestEvent(
    SHOP,
    { event: { name: "checkout_completed", clientId: "1.1", userAgent: "Mozilla/5.0 Chrome/120", consent: { analytics: true, marketing: false } } },
    undefined,
  );
  expect(gaCalls()).toHaveLength(1);
  expect(metaCalls()).toHaveLength(0); // Meta needs marketing consent
});

test("consent gating: marketing granted → Meta is also delivered", async () => {
  await ingestEvent(
    SHOP,
    { event: { name: "checkout_completed", clientId: "1.1", userAgent: "Mozilla/5.0 Chrome/120", consent: { analytics: true, marketing: true } } },
    undefined,
  );
  expect(gaCalls()).toHaveLength(1);
  expect(metaCalls()).toHaveLength(1);
});

test("a failed send is queued in the outbox for durable retry", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
  // page_viewed is opted into BOTH GA4 and Meta with no consent restriction, so both fan-out jobs run
  // and both fail → both get queued for retry (one outbox row each).
  await ingestEvent(SHOP, { event: { name: "page_viewed", clientId: "1.1", userAgent: "Mozilla/5.0 Chrome/120" } }, undefined);
  expect(prisma.deliveryOutbox.create).toHaveBeenCalledTimes(2);
});

test("first delivery of an event id claims it and fans out", async () => {
  await ingestEvent(SHOP, { event: { id: "evt-1", name: "page_viewed", clientId: "1.1", userAgent: "Mozilla/5.0 Chrome/120" } }, undefined);
  expect(prisma.processedWebhook.create).toHaveBeenCalledTimes(1);
  expect(prisma.processedWebhook.create.mock.calls[0][0].data.webhookId).toBe(`ingest:${SHOP}:evt-1`);
  expect(gaCalls()).toHaveLength(1);
});

test("a redelivered event id is deduped — no second server-side send", async () => {
  // The claim create fails (row already exists) on a replayed beacon → the event is dropped before fan-out.
  prisma.processedWebhook.create.mockRejectedValueOnce(new Error("unique constraint"));
  await ingestEvent(SHOP, { event: { id: "evt-1", name: "checkout_completed", clientId: "1.1", userAgent: "Mozilla/5.0 Chrome/120" } }, undefined);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(prisma.recentEvent.create).not.toHaveBeenCalled();
});

test("id-less event: a content hash (name+timestamp+clientId+data) is claimed for dedup", async () => {
  const ev = { name: "product_added_to_cart", clientId: "1.1", timestamp: "2026-07-02T10:00:00.000Z", userAgent: "Mozilla/5.0 Chrome/120", data: { id: "v1" } };
  await ingestEvent(SHOP, { event: ev }, undefined);
  expect(prisma.processedWebhook.create).toHaveBeenCalledTimes(1);
  expect(prisma.processedWebhook.create.mock.calls[0][0].data.webhookId).toMatch(new RegExp(`^ingest:${SHOP}:h:[0-9a-f]{64}$`));
});

test("id-less replay: the same payload hashes the same → deduped, no second send", async () => {
  prisma.processedWebhook.create.mockRejectedValueOnce(new Error("unique constraint"));
  const ev = { name: "product_added_to_cart", clientId: "1.1", timestamp: "2026-07-02T10:00:00.000Z", userAgent: "Mozilla/5.0 Chrome/120", data: { id: "v1" } };
  await ingestEvent(SHOP, { event: ev }, undefined);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(prisma.recentEvent.create).not.toHaveBeenCalled();
});

test("id-less content hash includes params: two custom events differing only in params don't collide", async () => {
  const base = { name: "generate_lead", custom: true, clientId: "1.1", timestamp: "2026-07-02T10:00:00.000Z", userAgent: "Mozilla/5.0 Chrome/120" };
  await ingestEvent(SHOP, { event: { ...base, params: { form: "quote" } } }, undefined);
  await ingestEvent(SHOP, { event: { ...base, params: { form: "trade-account" } } }, undefined);
  const ids = prisma.processedWebhook.create.mock.calls.map((c) => c[0].data.webhookId);
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]); // distinct params → distinct claim → the second isn't dropped
});

test("id-less and timestamp-less event: no claim (won't risk dropping a legit repeat), still delivers", async () => {
  await ingestEvent(SHOP, { event: { name: "page_viewed", clientId: "1.1", userAgent: "Mozilla/5.0 Chrome/120" } }, undefined);
  expect(prisma.processedWebhook.create).not.toHaveBeenCalled();
  expect(gaCalls()).toHaveLength(1);
});

test("a delivery-log write failure doesn't abort ingest (send already happened)", async () => {
  prisma.deliveryLog.createMany.mockRejectedValue(new Error("db down"));
  await expect(
    ingestEvent(SHOP, { event: { name: "page_viewed", clientId: "1.1", userAgent: "Mozilla/5.0 Chrome/120" } }, undefined),
  ).resolves.toBeUndefined();
  expect(gaCalls()).toHaveLength(1); // the fan-out still completed
});

test("UTM-tagged visit records first-touch attribution", async () => {
  await ingestEvent(
    SHOP,
    { event: { name: "page_viewed", clientId: "1.1", userAgent: "Mozilla/5.0 Chrome/120", utm: { utm_source: "google", utm_medium: "cpc" } } },
    undefined,
  );
  expect(prisma.visitorAttribution.upsert).toHaveBeenCalledTimes(1);
});
