import { channelFromJourney, orderIsSubscription, foldOrders, orderCustomerKey, numericGid, mergeUnattributed, isMigratedSource, UNATTRIBUTED } from "../app/lib/backfill.js";

const journey = (firstVisit) => ({ firstVisit });
const order = (over = {}) => ({
  id: "gid://shopify/Order/1",
  createdAt: "2026-07-01T10:00:00Z",
  totalPrice: 100,
  customer: { id: "gid://shopify/Customer/7" },
  customerJourneySummary: null,
  lineItems: [],
  ...over,
});
const sub = [{ sellingPlan: { name: "Monthly" } }];

describe("channelFromJourney", () => {
  test("prefers the first visit's UTM parameters", () => {
    const c = channelFromJourney(journey({ utmParameters: { source: "google", medium: "cpc", campaign: "brand" }, source: "facebook" }));
    expect(c).toEqual({ source: "google", medium: "cpc", campaign: "brand" });
  });

  test("falls back to Shopify's own source classification", () => {
    expect(channelFromJourney(journey({ source: "facebook" }))).toEqual({ source: "facebook", medium: "referral", campaign: null });
  });

  test("falls back to the referrer host", () => {
    expect(channelFromJourney(journey({ referrerUrl: "https://www.reddit.com/r/dogs" }))).toEqual({ source: "reddit.com", medium: "referral", campaign: null });
  });

  test("no journey at all → null (a renewal: there was no visit)", () => {
    expect(channelFromJourney(null)).toBeNull();
    expect(channelFromJourney(journey(null))).toBeNull();
    expect(channelFromJourney(journey({}))).toBeNull();
  });
});

describe("orderIsSubscription", () => {
  test("a selling-plan line makes it subscription revenue", () => {
    expect(orderIsSubscription({ lineItems: sub })).toBe(true);
    expect(orderIsSubscription({ lineItems: [{ sellingPlan: null }] })).toBe(false);
    expect(orderIsSubscription({})).toBe(false);
  });
});

describe("foldOrders", () => {
  // THE point of the whole backfill: a renewal has no journey of its own, so it can only get a channel by
  // inheriting the one that acquired the customer. GA4 cannot do this at all.
  test("a renewal inherits the channel from the customer's earliest order", () => {
    const acquiring = order({
      id: "o1",
      createdAt: "2026-06-01T10:00:00Z",
      customerJourneySummary: journey({ utmParameters: { source: "google", medium: "cpc" } }),
      lineItems: sub,
      totalPrice: 40,
    });
    const renewal = order({ id: "o2", createdAt: "2026-07-01T10:00:00Z", customerJourneySummary: null, lineItems: sub, totalPrice: 40 });

    const { rows, learned } = foldOrders([acquiring, renewal]); // oldest-first, as the pager yields them
    expect(rows).toHaveLength(2); // two different days
    for (const r of rows) {
      expect(r.source).toBe("google");
      expect(r.medium).toBe("cpc");
      expect(r.subscriptionRevenue).toBe(40); // both count as subscription revenue for that channel
    }
    // And we learned the customer's first touch → persisted so FUTURE renewals inherit it too.
    expect(learned).toEqual([{ customerKey: "7", source: "google", medium: "cpc", campaign: null, firstOrderId: "1" }]);
  });

  test("first touch carries across pages via the shared map (resumable paging)", () => {
    const page1 = [order({ id: "o1", createdAt: "2026-06-01T10:00:00Z", customerJourneySummary: journey({ utmParameters: { source: "klaviyo", medium: "email" } }) })];
    const page2 = [order({ id: "o2", createdAt: "2026-07-01T10:00:00Z", customerJourneySummary: null, lineItems: sub })];

    const { firstTouch } = foldOrders(page1);
    const { rows } = foldOrders(page2, firstTouch); // second page reuses the map
    expect(rows[0]).toMatchObject({ source: "klaviyo", medium: "email" });
  });

  test("a customer we can't attribute goes to (unattributed) — NEVER (direct)", () => {
    // The 60-day wall: an established subscriber's acquiring order is out of range, so the only order we
    // can see is a renewal with no journey. Folding this into (direct) would flatter direct and lie.
    const { rows } = foldOrders([order({ customerJourneySummary: null, lineItems: sub, totalPrice: 25 })]);
    expect(rows[0].source).toBe(UNATTRIBUTED);
    expect(rows[0].source).not.toBe("(direct)");
    expect(rows[0].subscriptionRevenue).toBe(25);
  });

  test("splits subscription vs one-off revenue and sums per day/channel", () => {
    const j = journey({ utmParameters: { source: "google", medium: "cpc" } });
    const { rows } = foldOrders([
      order({ id: "a", createdAt: "2026-07-01T01:00:00Z", customerJourneySummary: j, customer: { id: "c1" }, lineItems: sub, totalPrice: 30 }),
      order({ id: "b", createdAt: "2026-07-01T02:00:00Z", customerJourneySummary: j, customer: { id: "c2" }, lineItems: [], totalPrice: 70 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-07-01", orders: 2, revenue: 100, subscriptionOrders: 1, subscriptionRevenue: 30 });
  });

  test("a guest order (no customer) uses only its own journey", () => {
    const { rows, learned } = foldOrders([order({ customer: null, customerJourneySummary: journey({ source: "bing" }), totalPrice: 12 })]);
    expect(rows[0]).toMatchObject({ source: "bing", medium: "referral", revenue: 12 });
    expect(learned).toEqual([]); // nothing to persist without a customer key
  });
});

// The live orders/paid path looks CustomerAttribution up by the webhook's NUMERIC customer id, but GraphQL
// hands back a GID. Seeding the GID would write rows the live path could never find — the backfill would
// look like it worked and silently do nothing. These keys MUST agree.
describe("customer key matches the live pipeline (attribution.js customerKey)", () => {
  test("a GID is reduced to the numeric id the webhook delivers", () => {
    expect(numericGid("gid://shopify/Customer/9539392930134")).toBe("9539392930134");
    expect(numericGid("gid://shopify/Order/5500000000001")).toBe("5500000000001");
    expect(numericGid(null)).toBeNull();
  });

  test("orderCustomerKey returns the numeric id, not the GID", () => {
    expect(orderCustomerKey({ customer: { id: "gid://shopify/Customer/753" } })).toBe("753");
    expect(orderCustomerKey({ customer: null })).toBeNull();
    expect(orderCustomerKey({})).toBeNull();
  });
});

// Left unexplained, whoever reads this report WILL assume the unknowns are organic (or direct) — the two
// most flattering guesses. These counters exist so the report contradicts that with facts.
describe("(unattributed) breakdown", () => {
  test("counts renewals whose ACQUIRING order also had no journey — the migrated-subscriber case", () => {
    const { unattributed } = foldOrders([
      order({ id: "r1", customer: { id: "gid://shopify/Customer/1" }, customerJourneySummary: null, lineItems: sub, totalPrice: 40 }),
      order({ id: "r2", customer: { id: "gid://shopify/Customer/1" }, customerJourneySummary: null, lineItems: sub, totalPrice: 40 }),
    ]);
    expect(unattributed.orders).toBe(2);
    expect(unattributed.subscriptionOrders).toBe(2);
    expect(unattributed.subscriptionRevenue).toBe(80);
    expect(unattributed.knownCustomerNoJourney).toBe(2);
    expect(unattributed.guestNoJourney).toBe(0);
  });

  test("separates guest/POS/imported orders (no customer at all)", () => {
    const { unattributed } = foldOrders([order({ customer: null, customerJourneySummary: null, totalPrice: 10 })]);
    expect(unattributed.guestNoJourney).toBe(1);
    expect(unattributed.knownCustomerNoJourney).toBe(0);
  });

  test("organic traffic Shopify DID see is attributed — it never lands in the bucket", () => {
    const { rows, unattributed } = foldOrders([
      order({ customerJourneySummary: { firstVisit: { referrerUrl: "https://www.google.com/search?q=raw+dog+food" } }, totalPrice: 50 }),
    ]);
    expect(rows[0].source).toBe("google.com"); // attributed, not unknown
    expect(unattributed.orders).toBe(0);
  });

  test("merges across pages/ticks and widens the date span", () => {
    const a = { orders: 2, revenue: 10, subscriptionOrders: 1, subscriptionRevenue: 5, knownCustomerNoJourney: 2, guestNoJourney: 0, migratedOrders: 1, oldest: "2026-06-05", newest: "2026-06-10" };
    const b = { orders: 3, revenue: 20, subscriptionOrders: 2, subscriptionRevenue: 15, knownCustomerNoJourney: 1, guestNoJourney: 2, migratedOrders: 2, oldest: "2026-05-01", newest: "2026-07-01" };
    expect(mergeUnattributed(a, b)).toEqual({
      orders: 5, revenue: 30, subscriptionOrders: 3, subscriptionRevenue: 20,
      knownCustomerNoJourney: 3, guestNoJourney: 2, migratedOrders: 3, oldest: "2026-05-01", newest: "2026-07-01",
    });
  });
});

// THE unlock. An established subscriber's ACQUIRING order — the only one that ever carried a customer
// journey — is often a year+ old, outside the 90-day reporting window. Scanning only that window means we
// never learn their channel, so every renewal they've paid since lands in (unattributed). That was 79% of
// Naturaw's unattributed revenue. So: LEARN first-touch from all history, but only AGGREGATE revenue from
// the reporting window.
describe("two windows: learn first-touch from all history, count revenue only in the window", () => {
  const REVENUE_SINCE = "2026-04-15";

  test("an OLD acquiring order teaches the channel but adds no revenue; the in-window renewal inherits it", () => {
    const acquiring = order({
      id: "old",
      createdAt: "2024-02-03T10:00:00Z", // two years before the revenue window
      customer: { id: "gid://shopify/Customer/42" },
      customerJourneySummary: journey({ utmParameters: { source: "google", medium: "cpc" } }),
      lineItems: sub,
      totalPrice: 40,
    });
    const renewal = order({
      id: "new",
      createdAt: "2026-07-01T10:00:00Z", // inside the window
      customer: { id: "gid://shopify/Customer/42" },
      customerJourneySummary: null, // a renewal never has a journey
      lineItems: sub,
      totalPrice: 40,
    });

    const { rows, learned, unattributed } = foldOrders([acquiring, renewal], new Map(), { revenueSince: REVENUE_SINCE });

    // Only the in-window renewal contributes revenue — the 2024 order must NOT inflate the report.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-07-01", revenue: 40, subscriptionRevenue: 40 });
    // …but it carries the channel the 2024 order taught us. Without the deep scan this would be (unattributed).
    expect(rows[0].source).toBe("google");
    expect(rows[0].medium).toBe("cpc");
    expect(unattributed.orders).toBe(0);
    // And the first touch is persisted, so FUTURE renewals stay attributed too.
    expect(learned).toEqual([{ customerKey: "42", source: "google", medium: "cpc", campaign: null, firstOrderId: "old" }]);
  });

  test("without the deep scan, that same renewal is (unattributed) — this is the bug being fixed", () => {
    const renewal = order({
      createdAt: "2026-07-01T10:00:00Z",
      customer: { id: "gid://shopify/Customer/42" },
      customerJourneySummary: null,
      lineItems: sub,
      totalPrice: 40,
    });
    const { rows } = foldOrders([renewal], new Map(), { revenueSince: REVENUE_SINCE });
    expect(rows[0].source).toBe(UNATTRIBUTED);
  });

  test("out-of-window orders don't pollute the (unattributed) diagnostic either", () => {
    const old = order({ createdAt: "2024-05-01T10:00:00Z", customerJourneySummary: null, lineItems: sub, totalPrice: 99 });
    const { rows, unattributed } = foldOrders([old], new Map(), { revenueSince: REVENUE_SINCE });
    expect(rows).toHaveLength(0);
    expect(unattributed.orders).toBe(0);
  });
});

describe("isMigratedSource", () => {
  test("flags known store-migration/import tools", () => {
    expect(isMigratedSource("Matrixify App")).toBe(true);
    expect(isMigratedSource("Transporter")).toBe(true);
    expect(isMigratedSource("LitExtension")).toBe(true);
  });
  test("does not flag native storefront sources", () => {
    expect(isMigratedSource("Online Store")).toBe(false);
    expect(isMigratedSource("web")).toBe(false);
    expect(isMigratedSource("pos")).toBe(false);
    expect(isMigratedSource(null)).toBe(false);
    expect(isMigratedSource("")).toBe(false);
  });
});

describe("foldOrders: per-order unattributed export", () => {
  const IN_WINDOW = { revenueSince: "2026-06-01" };

  test("captures each unattributed order with its source, reason and migrated flag", () => {
    // A migrated-in renewal (Matrixify import, no journey) and a guest one-off with no journey.
    const imported = order({
      id: "gid://shopify/Order/900",
      name: "#IMP900",
      createdAt: "2026-07-01T10:00:00Z",
      customer: { id: "gid://shopify/Customer/50" },
      source: "Matrixify App",
      customerJourneySummary: null,
      lineItems: sub,
      totalPrice: 123.5,
    });
    const guest = order({
      id: "gid://shopify/Order/901",
      name: "#GST901",
      createdAt: "2026-07-02T10:00:00Z",
      customer: null,
      source: "Online Store",
      customerJourneySummary: null,
      lineItems: [],
      totalPrice: 40,
    });

    const { unattributed, unattributedOrders } = foldOrders([imported, guest], new Map(), IN_WINDOW);

    expect(unattributedOrders).toEqual([
      { orderId: "900", name: "#IMP900", date: "2026-07-01", revenue: 123.5, isSubscription: true, source: "Matrixify App", migrated: true, reason: "known_customer_no_journey", customerKey: "50" },
      { orderId: "901", name: "#GST901", date: "2026-07-02", revenue: 40, isSubscription: false, source: "Online Store", migrated: false, reason: "guest_no_journey", customerKey: null },
    ]);
    expect(unattributed.migratedOrders).toBe(1);
    expect(unattributed.orders).toBe(2);
  });

  test("does not list attributed orders, and windows out pre-window orders", () => {
    const attributed = order({
      id: "gid://shopify/Order/902",
      createdAt: "2026-07-01T10:00:00Z",
      source: "Online Store",
      customerJourneySummary: journey({ utmParameters: { source: "google", medium: "cpc" } }),
    });
    const oldUnattributed = order({
      id: "gid://shopify/Order/903",
      createdAt: "2026-01-01T10:00:00Z", // before revenueSince
      customer: { id: "gid://shopify/Customer/51" },
      source: "Matrixify App",
      customerJourneySummary: null,
    });
    const { unattributedOrders } = foldOrders([oldUnattributed, attributed], new Map(), IN_WINDOW);
    expect(unattributedOrders).toEqual([]); // attributed one isn't listed; old one is out of window
  });

  test("migratedOrders merges across pages", () => {
    const a = { ...mergeUnattributed(null, null), migratedOrders: 3 };
    const b = { ...mergeUnattributed(null, null), migratedOrders: 4 };
    expect(mergeUnattributed(a, b).migratedOrders).toBe(7);
  });
});
