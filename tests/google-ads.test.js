import { buildClickConversion, googleAdsIdentifiers, formatGoogleDateTime, verifyState, signState } from "../app/lib/google-ads.server.js";
import { sha256Hex } from "../app/lib/server-side.server.js";

const config = { customerId: "1234567890", conversionActionId: "987654321" };

describe("buildClickConversion", () => {
  test("builds a gclid conversion with the right resource name + value", () => {
    const c = buildClickConversion(config, { value: 42.5, currency: "GBP", transactionId: "555", gclid: "GCL123", timestamp: "2026-07-02T10:00:00.000Z" });
    expect(c.conversionAction).toBe("customers/1234567890/conversionActions/987654321");
    expect(c.gclid).toBe("GCL123");
    expect(c.conversionValue).toBe(42.5);
    expect(c.currencyCode).toBe("GBP");
    expect(c.orderId).toBe("555");
    expect(c.conversionDateTime).toBe("2026-07-02 10:00:00+00:00");
  });

  test("adds hashed Enhanced-Conversion identifiers", () => {
    const c = buildClickConversion(config, { value: 10, email: "Test@Example.com ", phone: "+1 (555) 123-4567", gclid: "G" });
    expect(c.userIdentifiers).toContainEqual({ hashedEmail: sha256Hex("test@example.com") });
    expect(c.userIdentifiers).toContainEqual({ hashedPhoneNumber: sha256Hex("15551234567") });
  });

  test("prefers gclid, else gbraid, else wbraid", () => {
    expect(buildClickConversion(config, { gbraid: "B", value: 1 }).gbraid).toBe("B");
    expect(buildClickConversion(config, { wbraid: "W", value: 1 }).wbraid).toBe("W");
    expect(buildClickConversion(config, { gclid: "G", gbraid: "B", value: 1 }).gbraid).toBeUndefined();
  });

  test("returns null with no match key at all", () => {
    expect(buildClickConversion(config, { value: 10 })).toBeNull();
  });
});

describe("googleAdsIdentifiers", () => {
  test("pulls click ids and email/phone off the event", () => {
    const ids = googleAdsIdentifiers({ clickIds: { gclid: "G", wbraid: "W" }, email: "a@b.com", data: { checkout: { phone: "123" } } });
    expect(ids.gclid).toBe("G");
    expect(ids.wbraid).toBe("W");
    expect(ids.email).toBe("a@b.com");
    expect(ids.phone).toBe("123");
  });
});

describe("formatGoogleDateTime", () => {
  test("formats to the Google Ads datetime shape", () => {
    expect(formatGoogleDateTime("2026-01-05T08:09:10.500Z")).toBe("2026-01-05 08:09:10+00:00");
  });
  test("falls back to now for a bad timestamp", () => {
    expect(formatGoogleDateTime("nonsense")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+00:00$/);
  });
});

describe("signState / verifyState", () => {
  const OLD = process.env.SHOPIFY_API_SECRET;
  beforeAll(() => { process.env.SHOPIFY_API_SECRET = "test-secret"; });
  afterAll(() => { process.env.SHOPIFY_API_SECRET = OLD; });

  test("round-trips a shop domain", () => {
    const shop = "demo.myshopify.com";
    expect(verifyState(signState(shop))).toBe(shop);
  });
  test("rejects a tampered state", () => {
    expect(verifyState("Zm9v.deadbeef")).toBeNull();
    expect(verifyState("garbage")).toBeNull();
    expect(verifyState("")).toBeNull();
  });
});
