/* eslint-disable import/first -- jest.mock() must precede the imports it intercepts */
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));
jest.mock("../app/lib/server-side.server.js", () => ({ __esModule: true, validateGa4Event: jest.fn() }));

import prisma from "../app/db.server.js";
import { validateGa4Event } from "../app/lib/server-side.server.js";
import { runConnectionChecks, CHECK_INTERVAL_MS } from "../app/lib/connection-check.server.js";

beforeEach(() => {
  jest.clearAllMocks();
  prisma.trackingSettings.findMany.mockResolvedValue([{ shopDomain: "s.myshopify.com", ga4Id: "G-1", serverSide: true }]);
  prisma.connectionCheck.findUnique.mockResolvedValue(null); // never checked → due
});

test("runs the GA4 validator for a due shop and stores a passing result", async () => {
  validateGa4Event.mockResolvedValue({ ok: true, messages: [] });
  const out = await runConnectionChecks({ now: Date.now() });
  expect(validateGa4Event).toHaveBeenCalledTimes(1);
  expect(out).toEqual({ checked: 1, failing: 1 - 1 }); // checked 1, failing 0
  const write = prisma.connectionCheck.upsert.mock.calls[0][0];
  expect(write.create).toMatchObject({ destination: "ga4", ok: true, detail: null });
});

test("stores a failure with the rejection detail", async () => {
  validateGa4Event.mockResolvedValue({ ok: false, messages: ["bad secret"] });
  const out = await runConnectionChecks({ now: Date.now() });
  expect(out.failing).toBe(1);
  expect(prisma.connectionCheck.upsert.mock.calls[0][0].create).toMatchObject({ ok: false, detail: "bad secret" });
});

test("skips a shop checked within the interval (no validator call)", async () => {
  prisma.connectionCheck.findUnique.mockResolvedValue({ checkedAt: new Date(Date.now() - CHECK_INTERVAL_MS / 2), ok: true });
  const out = await runConnectionChecks({ now: Date.now() });
  expect(validateGa4Event).not.toHaveBeenCalled();
  expect(out.checked).toBe(0);
});
