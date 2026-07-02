/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
import { jest } from "@jest/globals";
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));
import prisma from "../app/db.server.js";
import { buildClickConversion, googleAdsIdentifiers, formatGoogleDateTime, verifyState, signState, createOAuthState, consumeOAuthState } from "../app/lib/google-ads.server.js";
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

  test("round-trips shop + nonce", () => {
    const shop = "demo.myshopify.com";
    expect(verifyState(signState(shop, "nonce-abc"))).toEqual({ shop, nonce: "nonce-abc" });
  });
  test("rejects a tampered / malformed state", () => {
    expect(verifyState("Zm9v.bm9uY2U.deadbeef")).toBeNull(); // valid shape, bad sig
    expect(verifyState("Zm9v.deadbeef")).toBeNull(); // too few parts
    expect(verifyState("garbage")).toBeNull();
    expect(verifyState("")).toBeNull();
  });
  test("a nonce swap invalidates the signature", () => {
    const state = signState("demo.myshopify.com", "nonce-1");
    const [b, , sig] = state.split(".");
    const forged = `${b}.${Buffer.from("nonce-2").toString("base64url")}.${sig}`;
    expect(verifyState(forged)).toBeNull();
  });
});

describe("createOAuthState / consumeOAuthState", () => {
  const OLD = process.env.SHOPIFY_API_SECRET;
  beforeAll(() => { process.env.SHOPIFY_API_SECRET = "test-secret"; });
  afterAll(() => { process.env.SHOPIFY_API_SECRET = OLD; });
  beforeEach(() => { jest.clearAllMocks(); });

  test("mints a state that persists a nonce with a future expiry", async () => {
    const state = await createOAuthState("demo.myshopify.com");
    expect(prisma.shop.upsert).toHaveBeenCalledTimes(1);
    const { create } = prisma.shop.upsert.mock.calls[0][0];
    expect(create.googleOauthNonce).toBeTruthy();
    expect(create.googleOauthNonceExpiresAt.getTime()).toBeGreaterThan(Date.now());
    // the persisted nonce round-trips through the signed state
    expect(verifyState(state)).toEqual({ shop: "demo.myshopify.com", nonce: create.googleOauthNonce });
  });

  test("consumes a valid, matching, unexpired state → shop, and clears the nonce", async () => {
    const shop = "demo.myshopify.com";
    const state = await createOAuthState(shop);
    const nonce = verifyState(state).nonce;
    prisma.shop.findUnique.mockResolvedValue({ shopDomain: shop, googleOauthNonce: nonce, googleOauthNonceExpiresAt: new Date(Date.now() + 60_000) });
    expect(await consumeOAuthState(state)).toBe(shop);
    // single-use: nonce cleared
    expect(prisma.shop.update).toHaveBeenCalledWith({ where: { shopDomain: shop }, data: { googleOauthNonce: null, googleOauthNonceExpiresAt: null } });
  });

  test("rejects a replay (nonce already cleared)", async () => {
    prisma.shop.findUnique.mockResolvedValue({ shopDomain: "demo.myshopify.com", googleOauthNonce: null, googleOauthNonceExpiresAt: null });
    expect(await consumeOAuthState(signState("demo.myshopify.com", "whatever"))).toBeNull();
  });

  test("rejects an expired nonce", async () => {
    const shop = "demo.myshopify.com";
    const state = signState(shop, "nonce-x");
    prisma.shop.findUnique.mockResolvedValue({ shopDomain: shop, googleOauthNonce: "nonce-x", googleOauthNonceExpiresAt: new Date(Date.now() - 1000) });
    expect(await consumeOAuthState(state)).toBeNull();
  });

  test("rejects a nonce mismatch (valid HMAC, wrong stored nonce)", async () => {
    const shop = "demo.myshopify.com";
    const state = signState(shop, "nonce-a");
    prisma.shop.findUnique.mockResolvedValue({ shopDomain: shop, googleOauthNonce: "nonce-b", googleOauthNonceExpiresAt: new Date(Date.now() + 60_000) });
    expect(await consumeOAuthState(state)).toBeNull();
  });

  test("rejects a state with a bad signature without hitting the DB", async () => {
    expect(await consumeOAuthState("garbage")).toBeNull();
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
  });
});
