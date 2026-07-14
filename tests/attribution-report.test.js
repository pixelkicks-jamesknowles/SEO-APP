import { byFirstTouch, touchDistribution, multiTouchShare, firstVsLastShift, bySubscriptionSource, byChannelRevenue, channelGroupOf, byChannelGroup, visitAttribution, ltvByChannel } from "../app/lib/attribution-report.js";

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

describe("channelGroupOf (GA4-style default channel grouping)", () => {
  test.each([
    // [source, medium, expected]  — the actual source/medium shapes this store produces
    ["direct", "referral", "Direct"], // Shopify's own "direct" classification, tagged referral by us
    ["(direct)", "(none)", "Direct"],
    ["google", "referral", "Organic Search"], // search source, no paid medium
    ["google", "cpc", "Paid Search"],
    ["google", "organic", "Organic Search"],
    ["Bing", "referral", "Organic Search"], // case-insensitive
    ["facebook", "referral", "Organic Social"],
    ["facebook", "paid_social", "Paid Social"],
    ["Facebook_Mobile_Feed", "paid", "Paid Social"],
    ["Instagram_Feed", "paid", "Paid Social"],
    ["Klaviyo", "email", "Email"],
    ["metorik", "email", "Email"],
    ["https://shopify.com/", "referral", "Referral"],
    ["https://trade.naturaw.co.uk/", "referral", "Referral"],
    ["(unattributed)", "(none)", "(unattributed)"], // stays its own honest bucket
    ["some-random-thing", "weird_medium", "Unassigned"],
  ])("%s / %s → %s", (source, medium, expected) => {
    expect(channelGroupOf(source, medium)).toBe(expected);
  });
});

describe("byChannelGroup", () => {
  test("rolls source/medium rows up into channel groups with subscription split, sorted by revenue", () => {
    const groups = byChannelGroup([
      { source: "google", medium: "referral", orders: 10, revenue: 1000, subscriptionOrders: 4, subscriptionRevenue: 400 },
      { source: "bing", medium: "referral", orders: 2, revenue: 200, subscriptionOrders: 0, subscriptionRevenue: 0 },
      { source: "klaviyo", medium: "email", orders: 5, revenue: 300, subscriptionOrders: 5, subscriptionRevenue: 300 },
      { source: "(unattributed)", medium: "(none)", orders: 3, revenue: 500, subscriptionOrders: 3, subscriptionRevenue: 500 },
    ]);
    // google + bing collapse into one Organic Search row.
    const organic = groups.find((g) => g.group === "Organic Search");
    expect(organic).toMatchObject({ orders: 12, revenue: 1200, subscriptionRevenue: 400, oneOffRevenue: 800 });
    // (unattributed) is NOT folded into a real channel.
    expect(groups.find((g) => g.group === "(unattributed)")).toMatchObject({ revenue: 500 });
    // Sorted by revenue desc; shares are whole percents of the £2000 total.
    expect(groups[0].group).toBe("Organic Search");
    expect(organic.share).toBe(60);
  });

  test("empty input → empty array", () => {
    expect(byChannelGroup([])).toEqual([]);
  });
});

describe("visitAttribution (storefront first-touch: UTMs, else referrer)", () => {
  test("UTMs win outright", () => {
    expect(visitAttribution({ utm_source: "google", utm_medium: "cpc", utm_campaign: "brand" }, "https://anything.com")).toEqual({
      source: "google",
      medium: "cpc",
      campaign: "brand",
    });
  });
  test("a search-engine referrer becomes organic", () => {
    expect(visitAttribution(null, "https://www.google.com/search?q=dog+food")).toEqual({ source: "google", medium: "organic", campaign: null });
    expect(visitAttribution(null, "https://search.yahoo.com/")).toEqual({ source: "yahoo", medium: "organic", campaign: null });
  });
  test("a social referrer becomes social", () => {
    expect(visitAttribution(null, "https://l.facebook.com/")).toEqual({ source: "facebook", medium: "social", campaign: null });
  });
  test("any other referrer is a referral by host", () => {
    expect(visitAttribution(null, "https://blog.somepartner.co.uk/post")).toEqual({ source: "blog.somepartner.co.uk", medium: "referral", campaign: null });
  });
  test("no UTMs and no referrer → null (direct, records nothing)", () => {
    expect(visitAttribution(null, null)).toBeNull();
    expect(visitAttribution({}, "")).toBeNull();
    expect(visitAttribution(null, "not a url")).toBeNull();
  });
});

describe("ltvByChannel", () => {
  const customers = [
    { customerKey: "1", source: "google", medium: "cpc" },
    { customerKey: "2", source: "google", medium: "cpc" },
    // customer 3 has lifetime but no attribution row → (unattributed)
  ];
  const lifetimes = [
    { customerKey: "1", revenue: 300, orders: 4, lastOrderAt: "2026-07-10" },
    { customerKey: "2", revenue: 100, orders: 1, lastOrderAt: "2026-01-01" },
    { customerKey: "3", revenue: 500, orders: 6, lastOrderAt: "2026-07-12" },
  ];

  test("computes LTV, repeat and active rates by channel, and buckets unattributed", () => {
    const rows = ltvByChannel(customers, lifetimes, { activeWithinDays: 60, asOf: "2026-07-14" });
    const google = rows.find((r) => r.source === "google");
    expect(google).toMatchObject({ customers: 2, revenue: 400, ltv: 200, avgOrders: 2.5, repeatRate: 50, activeRate: 50 });
    const un = rows.find((r) => r.source === "(unattributed)");
    expect(un).toMatchObject({ customers: 1, ltv: 500, repeatRate: 100, activeRate: 100 });
  });

  test("sorted by LTV descending", () => {
    const rows = ltvByChannel(customers, lifetimes, { asOf: "2026-07-14" });
    expect(rows[0].source).toBe("(unattributed)"); // 500 > 200
  });

  test("empty input → empty array", () => {
    expect(ltvByChannel([], [])).toEqual([]);
  });
});
