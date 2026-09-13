/* eslint-disable import/first -- jest.mock() must precede the imports it intercepts */
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { checkPixelSettings, runPixelConfigChecks, PIXEL_DESTINATION } from "../app/lib/pixel-config-check.server.js";
import { evaluateHealth } from "../app/lib/health.js";

const URL_OK = "https://tracking.example.com/pixel/track";
// Settings come back double-encoded: { config: "<json string>" }, because WebPixelInput.settings is
// itself a JSON string.
const settings = (config) => JSON.stringify({ config: JSON.stringify(config) });

describe("checkPixelSettings", () => {
  test("a correctly configured pixel passes", () => {
    const raw = settings({ trackUrl: URL_OK, trackToken: "tok123" });
    expect(checkPixelSettings(raw, { expectedUrl: URL_OK, expectedToken: "tok123" })).toEqual({ ok: true, detail: null });
  });

  test("a stale trackUrl is caught and names both URLs", () => {
    const raw = settings({ trackUrl: "https://old-host.up.railway.app/pixel/track", trackToken: "tok123" });
    const res = checkPixelSettings(raw, { expectedUrl: URL_OK, expectedToken: "tok123" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("old-host.up.railway.app");
    expect(res.detail).toContain(URL_OK);
    expect(res.detail).toMatch(/press Save/i);
  });

  test("a token invalidated by an app-secret rotation is caught", () => {
    const raw = settings({ trackUrl: URL_OK, trackToken: "STALE" });
    const res = checkPixelSettings(raw, { expectedUrl: URL_OK, expectedToken: "tok123" });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/app secret was rotated/i);
  });

  test("neither token is ever leaked into the message", () => {
    // This string reaches an in-app banner and the merchant's alert webhook.
    const raw = settings({ trackUrl: URL_OK, trackToken: "STALE-SECRET-VALUE" });
    const res = checkPixelSettings(raw, { expectedUrl: URL_OK, expectedToken: "REAL-SECRET-VALUE" });
    expect(res.detail).not.toContain("STALE-SECRET-VALUE");
    expect(res.detail).not.toContain("REAL-SECRET-VALUE");
  });

  test("both problems at once are reported together", () => {
    const raw = settings({ trackUrl: "https://old/pixel/track", trackToken: "STALE" });
    const res = checkPixelSettings(raw, { expectedUrl: URL_OK, expectedToken: "tok123" });
    expect(res.detail).toContain("https://old/pixel/track");
    expect(res.detail).toMatch(/app secret was rotated/i);
  });

  test("unreadable or absent settings are reported, not thrown", () => {
    expect(checkPixelSettings("not json", { expectedUrl: URL_OK }).ok).toBe(false);
    expect(checkPixelSettings(JSON.stringify({}), { expectedUrl: URL_OK }).ok).toBe(false);
    expect(checkPixelSettings(null, { expectedUrl: URL_OK }).ok).toBe(false);
  });
});

describe("runPixelConfigChecks", () => {
  const SHOP = "s.myshopify.com";
  const adminReturning = (pixel) => async () => ({ graphql: async () => ({ json: async () => ({ data: { webPixel: pixel } }) }) });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SHOPIFY_APP_URL = "https://tracking.example.com";
    prisma.trackingSettings.findMany.mockResolvedValue([{ shopDomain: SHOP, webPixelId: "gid://shopify/WebPixel/1" }]);
    prisma.connectionCheck.findUnique.mockResolvedValue(null);
  });

  test("records a failure when the pixel points at the wrong host", async () => {
    const admin = adminReturning({ id: "gid://shopify/WebPixel/1", settings: settings({ trackUrl: "https://old/pixel/track", trackToken: "x" }) });
    const res = await runPixelConfigChecks({ adminFor: admin });
    expect(res).toMatchObject({ checked: 1, failing: 1 });
    const call = prisma.connectionCheck.upsert.mock.calls[0][0];
    expect(call.where.shopDomain_destination.destination).toBe(PIXEL_DESTINATION);
    expect(call.update.ok).toBe(false);
  });

  test("a deleted pixel is reported as missing", async () => {
    const res = await runPixelConfigChecks({ adminFor: adminReturning(null) });
    expect(res.failing).toBe(1);
    expect(prisma.connectionCheck.upsert.mock.calls[0][0].update.detail).toMatch(/missing from this store/i);
  });

  test("skips a shop checked recently, so it doesn't hammer the Admin API", async () => {
    prisma.connectionCheck.findUnique.mockResolvedValue({ checkedAt: new Date() });
    const res = await runPixelConfigChecks({ adminFor: adminReturning(null) });
    expect(res).toMatchObject({ checked: 0 });
    expect(prisma.connectionCheck.upsert).not.toHaveBeenCalled();
  });

  test("an Admin API failure records NOTHING — it says nothing about the pixel", async () => {
    const admin = async () => {
      throw new Error("502 Bad Gateway");
    };
    const res = await runPixelConfigChecks({ adminFor: admin });
    expect(res).toMatchObject({ checked: 0, failing: 0 });
    expect(prisma.connectionCheck.upsert).not.toHaveBeenCalled();
  });

  test("with no SHOPIFY_APP_URL it skips rather than alarming every shop", async () => {
    delete process.env.SHOPIFY_APP_URL;
    const res = await runPixelConfigChecks({ adminFor: adminReturning(null) });
    expect(res.skipped).toBeTruthy();
    expect(prisma.connectionCheck.upsert).not.toHaveBeenCalled();
  });
});

describe("the failure becomes a merchant-facing alert", () => {
  test("web_pixel gets its own copy, not the GA4 'check your measurement ID' text", () => {
    const { alerts } = evaluateHealth({
      connectionFailures: [{ destination: "web_pixel", detail: "The Web Pixel is installed but its access token no longer matches this app." }],
    });
    const alert = alerts.find((a) => a.kind === "connection_web_pixel");
    expect(alert.severity).toBe("critical");
    expect(alert.title).toMatch(/Storefront events are not reaching/i);
    expect(alert.body).toMatch(/access token no longer matches/i);
    expect(alert.body).not.toMatch(/measurement ID/i);
  });

  test("other destinations keep the existing copy", () => {
    const { alerts } = evaluateHealth({ connectionFailures: [{ destination: "ga4", detail: "401" }] });
    const alert = alerts.find((a) => a.kind === "connection_ga4");
    expect(alert.body).toMatch(/measurement ID/i);
  });
});
