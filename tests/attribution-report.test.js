import { byFirstTouch, touchDistribution, multiTouchShare, firstVsLastShift, bySubscriptionSource, byChannelRevenue } from "../app/lib/attribution-report.js";

const visitors = [
  { source: "google", medium: "cpc", visits: 3, lastSource: "google" },
  { source: "google", medium: "cpc", visits: 1, lastSource: "newsletter" },
  { source: "facebook", medium: "paid", visits: 5, lastSource: "facebook" },
  { source: null, medium: null, visits: 1, lastSource: null }, // direct
];

describe("byFirstTouch", () => {
  test("groups by source/medium and sorts by visitors desc", () => {
    const g = byFirstTouch(visitors);
    expect(g[0]).toEqual({ source: "google", medium: "cpc", visitors: 2, touches: 4 });
    expect(g.find((r) => r.source === "(direct)")).toMatchObject({ visitors: 1 });
  });
});

describe("touchDistribution", () => {
  test("buckets 1/2/3/4+", () => {
    expect(touchDistribution(visitors)).toEqual({ "1": 2, "2": 0, "3": 1, "4+": 1 });
  });
});

describe("multiTouchShare", () => {
  test("percent of visitors with >1 touch", () => {
    expect(multiTouchShare(visitors)).toBe(50); // 2 of 4 have visits > 1
  });
  test("null when no rows", () => {
    expect(multiTouchShare([])).toBeNull();
  });
});

describe("firstVsLastShift", () => {
  test("counts visitors whose latest source differs from first", () => {
    expect(firstVsLastShift(visitors)).toBe(1); // the google→newsletter one
  });
});

describe("bySubscriptionSource", () => {
  test("groups subscription customers by source/medium", () => {
    const g = bySubscriptionSource([
      { source: "google", medium: "cpc" },
      { source: "google", medium: "cpc" },
      { source: null, medium: null },
    ]);
    expect(g[0]).toEqual({ source: "google", medium: "cpc", customers: 2 });
    expect(g[1]).toEqual({ source: "(direct)", medium: "(none)", customers: 1 });
  });
});

describe("byChannelRevenue", () => {
  test("sums orders + revenue per channel with AOV, share, and grand totals, sorted by revenue", () => {
    const { channels, totalRevenue, totalOrders } = byChannelRevenue([
      { source: "google", medium: "cpc", orders: 2, revenue: 200 },
      { source: "google", medium: "cpc", orders: 1, revenue: 100 }, // another day, same channel
      { source: null, medium: null, orders: 1, revenue: 50 },
    ]);
    expect(totalOrders).toBe(4);
    expect(totalRevenue).toBe(350);
    // Rows with no subscription columns (all revenue is one-off) still reconcile.
    expect(channels[0]).toEqual({ source: "google", medium: "cpc", orders: 3, revenue: 300, aov: 100, share: 86, subscriptionOrders: 0, subscriptionRevenue: 0, oneOffRevenue: 300 });
    expect(channels[1]).toEqual({ source: "(direct)", medium: "(none)", orders: 1, revenue: 50, aov: 50, share: 14, subscriptionOrders: 0, subscriptionRevenue: 0, oneOffRevenue: 50 });
  });

  test("empty input → zero totals, no channels", () => {
    expect(byChannelRevenue([])).toEqual({ channels: [], totalRevenue: 0, totalOrders: 0, totalSubscriptionRevenue: 0, totalSubscriptionOrders: 0 });
  });
});

// Recurring renewals carry the customer's first-touch source, so this report answers "which channel drove
// our subscription revenue" — the question GA4 structurally cannot answer (a renewal has no browser
// session, so GA4 can only ever report it as Unassigned).
describe("byChannelRevenue — subscription split", () => {
  const rows = [
    { source: "google", medium: "cpc", orders: 4, revenue: 400, subscriptionOrders: 3, subscriptionRevenue: 300 },
    { source: "google", medium: "cpc", orders: 1, revenue: 100, subscriptionOrders: 1, subscriptionRevenue: 100 },
    { source: "klaviyo", medium: "email", orders: 2, revenue: 50, subscriptionOrders: 0, subscriptionRevenue: 0 },
  ];

  test("aggregates subscription revenue per channel, and one-off reconciles to the total", () => {
    const { channels } = byChannelRevenue(rows);
    const google = channels.find((c) => c.source === "google");
    expect(google.revenue).toBe(500);
    expect(google.subscriptionRevenue).toBe(400);
    expect(google.oneOffRevenue).toBe(100); // 500 - 400
    expect(google.subscriptionOrders).toBe(4);

    const email = channels.find((c) => c.source === "klaviyo");
    expect(email.subscriptionRevenue).toBe(0);
    expect(email.oneOffRevenue).toBe(50);
  });

  test("returns subscription grand totals", () => {
    const r = byChannelRevenue(rows);
    expect(r.totalRevenue).toBe(550);
    expect(r.totalSubscriptionRevenue).toBe(400);
    expect(r.totalSubscriptionOrders).toBe(4);
  });

  test("legacy rows without the split columns still total correctly (no NaN)", () => {
    const r = byChannelRevenue([{ source: "google", medium: "cpc", orders: 1, revenue: 100 }]);
    expect(r.totalRevenue).toBe(100);
    expect(r.totalSubscriptionRevenue).toBe(0);
    expect(r.channels[0].oneOffRevenue).toBe(100);
  });
});
