import { pixelToken, verifyPixelToken } from "../app/lib/pixel-token.server.js";

// Token verification is the only guard on the unsigned /pixel/track beacon, so pin its behaviour.
const OLD = process.env.SHOPIFY_API_SECRET;
beforeAll(() => {
  process.env.SHOPIFY_API_SECRET = "test-secret";
});
afterAll(() => {
  process.env.SHOPIFY_API_SECRET = OLD;
});

describe("pixelToken / verifyPixelToken", () => {
  it("is deterministic and shop-specific", () => {
    const a = pixelToken("shop-a.myshopify.com");
    expect(a).toBe(pixelToken("shop-a.myshopify.com"));
    expect(a).not.toBe(pixelToken("shop-b.myshopify.com"));
    expect(a).toHaveLength(32);
  });

  it("accepts the matching token and rejects everything else", () => {
    const shop = "shop-a.myshopify.com";
    const token = pixelToken(shop);
    expect(verifyPixelToken(shop, token)).toBe(true);
    // A valid token for shop-a must not authorise shop-b (the whole point).
    expect(verifyPixelToken("shop-b.myshopify.com", token)).toBe(false);
    expect(verifyPixelToken(shop, "wrong")).toBe(false);
    expect(verifyPixelToken(shop, null)).toBe(false);
    expect(verifyPixelToken(shop, undefined)).toBe(false);
    expect(verifyPixelToken(shop, `${token}x`)).toBe(false);
  });

  it("returns null / rejects when no secret is configured", () => {
    const prev = process.env.SHOPIFY_API_SECRET;
    delete process.env.SHOPIFY_API_SECRET;
    expect(pixelToken("shop-a.myshopify.com")).toBeNull();
    expect(verifyPixelToken("shop-a.myshopify.com", "anything")).toBe(false);
    process.env.SHOPIFY_API_SECRET = prev;
  });
});
