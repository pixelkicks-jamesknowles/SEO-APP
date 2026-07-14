/* eslint-disable import/first -- jest.mock() must precede the imports it intercepts */
// Regression test for the daily FX refresh. The old endpoint (api.exchangerate.host) moved behind a required
// access_key and started returning {success:false, error:...} with NO `rates` field, so every tick logged
// "no rates in response" and rates went stale. These pin: a valid keyless response refreshes, an
// error-shaped body fails cleanly (doesn't write), and today's snapshot is not re-fetched.
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { refreshFxRates } from "../app/lib/fx.server.js";

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.fxRate.findUnique.mockResolvedValue(null); // no snapshot yet → proceed to fetch
});

test("valid keyless response (open.er-api shape) is stored", async () => {
  global.fetch = jest.fn(async () => okJson({ result: "success", base_code: "USD", rates: { USD: 1, GBP: 0.75, EUR: 0.88 } }));
  const out = await refreshFxRates();
  expect(out.refreshed).toBe(true);
  expect(out.count).toBeGreaterThanOrEqual(3);
  expect(prisma.fxRate.upsert).toHaveBeenCalledTimes(1);
});

test("the exchangerate.host error body (no rates) fails cleanly and writes nothing", async () => {
  global.fetch = jest.fn(async () => okJson({ success: false, error: { code: 101, type: "missing_access_key" } }));
  const out = await refreshFxRates();
  expect(out).toEqual({ refreshed: false, reason: "no rates in response" });
  expect(prisma.fxRate.upsert).not.toHaveBeenCalled();
});

test("an empty/rate-less rates object is rejected too", async () => {
  global.fetch = jest.fn(async () => okJson({ rates: {} }));
  const out = await refreshFxRates();
  expect(out.reason).toBe("no rates in response");
  expect(prisma.fxRate.upsert).not.toHaveBeenCalled();
});

test("a non-2xx response reports the status and does not write", async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  const out = await refreshFxRates();
  expect(out).toEqual({ refreshed: false, reason: "http 503" });
  expect(prisma.fxRate.upsert).not.toHaveBeenCalled();
});

test("today's snapshot already present → no fetch, no write", async () => {
  prisma.fxRate.findUnique.mockResolvedValue({ base: "USD", date: "2026-07-14", rates: "{}" });
  global.fetch = jest.fn();
  const out = await refreshFxRates();
  expect(out).toEqual({ refreshed: false, reason: "already have today" });
  expect(global.fetch).not.toHaveBeenCalled();
});
