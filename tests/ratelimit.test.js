import { checkIngestRate, __resetRateLimiter, RATE_LIMITS, scaledShopLimit } from "../app/lib/ratelimit.server.js";

beforeEach(() => __resetRateLimiter());

const SHOP = "s.myshopify.com";

describe("scaledShopLimit (cross-replica correction)", () => {
  test("divides the global ceiling across replicas so the aggregate stays near the target", () => {
    expect(scaledShopLimit(3000, 1)).toBe(3000);
    expect(scaledShopLimit(3000, 3)).toBe(1000); // 3 replicas × 1000 ≈ the 3000 global ceiling
    expect(scaledShopLimit(3000, 4)).toBe(750);
  });
  test("never drops below 1, and treats a bad/zero replica count as single-process", () => {
    expect(scaledShopLimit(10, 100)).toBe(1);
    expect(scaledShopLimit(3000, 0)).toBe(3000);
  });
  test("the default build is single-process (REPLICAS = 1)", () => {
    expect(RATE_LIMITS.REPLICAS).toBe(1);
  });
});

test("allows traffic under the per-IP ceiling, then 429s over it", () => {
  const now = 1_000_000;
  for (let i = 0; i < RATE_LIMITS.PER_IP_LIMIT; i++) {
    expect(checkIngestRate(SHOP, "1.2.3.4", { now }).ok).toBe(true);
  }
  const over = checkIngestRate(SHOP, "1.2.3.4", { now });
  expect(over.ok).toBe(false);
  expect(over.retryAfter).toBeGreaterThan(0);
});

test("the window resets after RATE_LIMIT_WINDOW elapses", () => {
  const now = 2_000_000;
  for (let i = 0; i <= RATE_LIMITS.PER_IP_LIMIT; i++) checkIngestRate(SHOP, "9.9.9.9", { now });
  expect(checkIngestRate(SHOP, "9.9.9.9", { now }).ok).toBe(false);
  // Advance past the window → quota refills.
  expect(checkIngestRate(SHOP, "9.9.9.9", { now: now + RATE_LIMITS.WINDOW_MS + 1 }).ok).toBe(true);
});

test("separate IPs get separate per-IP budgets", () => {
  const now = 3_000_000;
  for (let i = 0; i <= RATE_LIMITS.PER_IP_LIMIT; i++) checkIngestRate(SHOP, "a", { now });
  expect(checkIngestRate(SHOP, "a", { now }).ok).toBe(false);
  expect(checkIngestRate(SHOP, "b", { now }).ok).toBe(true); // a different IP is unaffected
});

test("the per-shop ceiling limits a distributed flood across many IPs", () => {
  const now = 4_000_000;
  let blocked = false;
  // Each IP stays under the per-IP cap, but together they blow the per-shop cap.
  for (let i = 0; i < RATE_LIMITS.PER_SHOP_LIMIT + 10; i++) {
    const r = checkIngestRate(SHOP, `ip-${i % 1000}`, { now });
    if (!r.ok) blocked = true;
  }
  expect(blocked).toBe(true);
});

test("fails open when the shop is missing (never a new way to drop good events)", () => {
  expect(checkIngestRate(null, "1.2.3.4").ok).toBe(true);
});
