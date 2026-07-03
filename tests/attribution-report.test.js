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
    expect(channels[0]).toEqual({ source: "google", medium: "cpc", orders: 3, revenue: 300, aov: 100, share: 86 });
    expect(channels[1]).toEqual({ source: "(direct)", medium: "(none)", orders: 1, revenue: 50, aov: 50, share: 14 });
  });

  test("empty input → zero totals, no channels", () => {
    expect(byChannelRevenue([])).toEqual({ channels: [], totalRevenue: 0, totalOrders: 0 });
  });
});
