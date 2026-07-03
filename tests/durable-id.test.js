import { readDurableId, mintDurableId, isValidDurableId, durableCookie, resolveDurableId, DURABLE_COOKIE } from "../app/lib/durable-id.server.js";

const req = (cookie) => ({ headers: { get: (h) => (h.toLowerCase() === "cookie" ? cookie : null) } });
const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("isValidDurableId", () => {
  test("accepts a UUID v4-shaped id, rejects junk", () => {
    expect(isValidDurableId(UUID)).toBe(true);
    expect(isValidDurableId("not-a-uuid")).toBe(false);
    expect(isValidDurableId("")).toBe(false);
    expect(isValidDurableId("<script>".repeat(20))).toBe(false);
  });
});

describe("mintDurableId", () => {
  test("mints a valid, unique id", () => {
    const a = mintDurableId();
    const b = mintDurableId();
    expect(isValidDurableId(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("readDurableId", () => {
  test("reads a valid pxp_id from the Cookie header (among others)", () => {
    expect(readDurableId(req(`_ga=GA1.1.1.2; ${DURABLE_COOKIE}=${UUID}; _shopify_y=abc`))).toBe(UUID);
  });
  test("returns null when absent or malformed", () => {
    expect(readDurableId(req("_ga=GA1.1.1.2"))).toBeNull();
    expect(readDurableId(req(`${DURABLE_COOKIE}=junk`))).toBeNull();
    expect(readDurableId(req(""))).toBeNull();
  });
});

describe("durableCookie", () => {
  test("is a first-party, Secure, long-lived, non-HttpOnly cookie (pixel must read it)", () => {
    const c = durableCookie(UUID);
    expect(c).toContain(`${DURABLE_COOKIE}=${UUID}`);
    expect(c).toContain("Max-Age=34560000"); // 400 days
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Secure");
    expect(c).not.toContain("HttpOnly");
  });
});

describe("resolveDurableId", () => {
  test("reuses a valid existing cookie and re-sets it (sliding expiry)", () => {
    const { id, setCookie } = resolveDurableId(req(`${DURABLE_COOKIE}=${UUID}`));
    expect(id).toBe(UUID);
    expect(setCookie).toContain(UUID);
  });
  test("mints a fresh id when none is present", () => {
    const { id, setCookie } = resolveDurableId(req(""));
    expect(isValidDurableId(id)).toBe(true);
    expect(setCookie).toContain(id);
  });
});
