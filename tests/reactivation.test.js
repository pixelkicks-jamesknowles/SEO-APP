import { subscriptionLifecycleOf, REACTIVATION_CYCLE_MULTIPLIER, DEFAULT_INTERVAL_DAYS } from "../app/lib/subscription.js";
import { orderIsSubscription } from "../app/lib/backfill.js";
import { byAcquisition } from "../app/lib/attribution-report.js";

const subLine = { selling_plan_allocation: { selling_plan: { id: "1", name: "Every 28 days" } } };
const day = (n) => new Date(Date.UTC(2026, 0, n)).toISOString();

const subOrder = (id, createdDay) => ({ id, created_at: day(createdDay), line_items: [subLine], customer: { orders_count: 5 } });

describe("subscriptionLifecycleOf", () => {
  test("an on-time renewal is a renewal", () => {
    const prior = { firstSubscriptionOrderId: "1", lastSubscriptionOrderAt: day(1), lastSubscriptionIntervalDays: 28 };
    expect(subscriptionLifecycleOf(subOrder("2", 29), prior)).toBe("renewal");
  });

  test("a late-but-plausible renewal is still a renewal", () => {
    const prior = { firstSubscriptionOrderId: "1", lastSubscriptionOrderAt: day(1), lastSubscriptionIntervalDays: 28 };
    // 40 days on a 28-day cycle: late, not lapsed. Over-calling reactivation is the worse error.
    expect(subscriptionLifecycleOf(subOrder("2", 41), prior)).toBe("renewal");
  });

  test("a gap well beyond the cadence is a reactivation", () => {
    const prior = { firstSubscriptionOrderId: "1", lastSubscriptionOrderAt: day(1), lastSubscriptionIntervalDays: 28 };
    // 28 * 2.5 = 70 days. Day 100 is comfortably past it.
    expect(subscriptionLifecycleOf(subOrder("2", 100), prior)).toBe("reactivation");
  });

  test("the threshold follows the cadence, not a fixed number of days", () => {
    const weekly = { firstSubscriptionOrderId: "1", lastSubscriptionOrderAt: day(1), lastSubscriptionIntervalDays: 7 };
    // 7 * 2.5 = 17.5 days. A 30-day gap is a lapse for a weekly subscriber...
    expect(subscriptionLifecycleOf(subOrder("2", 31), weekly)).toBe("reactivation");
    const quarterly = { firstSubscriptionOrderId: "1", lastSubscriptionOrderAt: day(1), lastSubscriptionIntervalDays: 90 };
    // ...but routine for a quarterly one.
    expect(subscriptionLifecycleOf(subOrder("2", 31), quarterly)).toBe("renewal");
  });

  test("no cadence recorded falls back to the default cycle", () => {
    const prior = { firstSubscriptionOrderId: "1", lastSubscriptionOrderAt: day(1) };
    const threshold = DEFAULT_INTERVAL_DAYS * REACTIVATION_CYCLE_MULTIPLIER; // 70 days
    expect(subscriptionLifecycleOf(subOrder("2", Math.floor(threshold) - 10), prior)).toBe("renewal");
    expect(subscriptionLifecycleOf(subOrder("2", Math.ceil(threshold) + 10), prior)).toBe("reactivation");
  });

  test("the acquiring checkout is never a reactivation", () => {
    const order = subOrder("1", 1);
    expect(subscriptionLifecycleOf(order, { firstSubscriptionOrderId: "1", lastSubscriptionOrderAt: day(1) })).toBe("subscription_checkout");
  });

  test("a one-off is unaffected", () => {
    const order = { id: "9", created_at: day(100), line_items: [{ title: "mug" }] };
    expect(subscriptionLifecycleOf(order, { lastSubscriptionOrderAt: day(1) })).toBe("one_off");
  });

  test("with no prior history it stays a renewal rather than guessing", () => {
    expect(subscriptionLifecycleOf(subOrder("2", 100), { firstSubscriptionOrderId: "1" })).toBe("renewal");
  });

  test("an out-of-order webhook never produces a reactivation from a negative gap", () => {
    const prior = { firstSubscriptionOrderId: "1", lastSubscriptionOrderAt: day(100), lastSubscriptionIntervalDays: 28 };
    expect(subscriptionLifecycleOf(subOrder("2", 5), prior)).toBe("renewal");
  });
});

describe("backfill orderIsSubscription — parity with the live path", () => {
  test("a Shopify selling plan counts", () => {
    expect(orderIsSubscription({ lineItems: [{ sellingPlan: { name: "Every 28 days" } }] })).toBe(true);
  });

  test("a Recharge tag-only renewal counts, matching orders/paid", () => {
    // Without this the backfill reported less subscription revenue than the live path for the same store.
    expect(orderIsSubscription({ lineItems: [{ sellingPlan: null }], tags: "Subscription Recurring Order" })).toBe(true);
  });

  test("a Recharge note attribute counts", () => {
    const order = { lineItems: [], note_attributes: [{ name: "subscription_order_type", value: "recurring_subscription" }] };
    expect(orderIsSubscription(order)).toBe(true);
  });

  test("a genuine one-off does not", () => {
    expect(orderIsSubscription({ lineItems: [{ sellingPlan: null }], tags: "vip" })).toBe(false);
  });
});

describe("byAcquisition reports reactivations in their own bucket", () => {
  test("not folded into new subscribers, renewals, or one-offs", () => {
    const { rows, totalReactivations, totalNewSubscribers } = byAcquisition([
      { source: "google", medium: "cpc", campaign: "(none)", orderType: "subscription_checkout", customerType: "new", orders: 3, revenue: 30 },
      { source: "google", medium: "cpc", campaign: "(none)", orderType: "reactivation", customerType: "returning", orders: 2, revenue: 20 },
      { source: "google", medium: "cpc", campaign: "(none)", orderType: "renewal", customerType: "returning", orders: 5, revenue: 50 },
      { source: "google", medium: "cpc", campaign: "(none)", orderType: "one_off", customerType: "new", orders: 1, revenue: 10 },
    ]);
    expect(rows[0]).toMatchObject({ newSubscribers: 3, reactivations: 2, renewals: 5, oneOff: 1 });
    expect(totalReactivations).toBe(2);
    expect(totalNewSubscribers).toBe(3); // a reactivation is NOT new acquisition — they were won once already
  });
});
