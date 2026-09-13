import { orderTypeOf, orderHasSubscription, isFirstSubscriptionOrder } from "../app/lib/subscription.js";
import { foldOrders } from "../app/lib/backfill.js";

const subLine = { selling_plan_allocation: { selling_plan: { id: "1", name: "Every 28 days" } } };
const plainLine = { title: "one off" };

describe("orderHasSubscription — Recharge marker fallback", () => {
  test("selling plan still counts", () => {
    expect(orderHasSubscription({ line_items: [subLine] })).toBe(true);
  });

  test("Recharge renewal with NO selling plan counts as subscription (tag)", () => {
    // Recharge on its own checkout creates orders with no selling plan. Before this, orders/paid recorded
    // these with isSubscription=false, so their revenue never reached subscriptionRevenue.
    expect(orderHasSubscription({ line_items: [plainLine], tags: "Subscription Recurring Order" })).toBe(true);
  });

  test("Recharge checkout via note attribute counts", () => {
    const order = { line_items: [plainLine], note_attributes: [{ name: "subscription_order_type", value: "checkout_subscription" }] };
    expect(orderHasSubscription(order)).toBe(true);
  });

  test("a genuine one-off is still not a subscription", () => {
    expect(orderHasSubscription({ line_items: [plainLine], tags: "wholesale" })).toBe(false);
  });
});

describe("isFirstSubscriptionOrder", () => {
  test("no recorded history → this is the first subscription order we've seen", () => {
    expect(isFirstSubscriptionOrder({ id: "500", line_items: [subLine] }, null)).toBe(true);
  });

  test("recorded id matches → the acquiring checkout", () => {
    expect(isFirstSubscriptionOrder({ id: "500", line_items: [subLine] }, "500")).toBe(true);
  });

  test("recorded id differs → a renewal", () => {
    expect(isFirstSubscriptionOrder({ id: "900", line_items: [subLine] }, "500")).toBe(false);
  });

  test("non-subscription order is never a first subscription order", () => {
    expect(isFirstSubscriptionOrder({ id: "900", line_items: [plainLine] }, null)).toBe(false);
  });

  test("numeric vs string ids compare equal", () => {
    expect(isFirstSubscriptionOrder({ id: 500, line_items: [subLine] }, "500")).toBe(true);
  });
});

describe("orderTypeOf with the corrected signal — the bug this fixes", () => {
  const subOrder = (id, ordersCount) => ({ id, line_items: [subLine], customer: { orders_count: ordersCount } });

  test("one-off buyer who later subscribes is a CHECKOUT, not a renewal", () => {
    // orders_count is 2 (they bought a one-off first), which is exactly the case the old
    // isFirstOrder-derived signal reported as "renewal".
    const order = subOrder("500", 2);
    const recorded = null; // no prior subscription order for this customer
    expect(orderTypeOf(order, { isFirstSubscriptionOrder: isFirstSubscriptionOrder(order, recorded) })).toBe("subscription_checkout");
  });

  test("their later renewal is still a renewal", () => {
    const order = subOrder("900", 3);
    expect(orderTypeOf(order, { isFirstSubscriptionOrder: isFirstSubscriptionOrder(order, "500") })).toBe("renewal");
  });

  test("genuinely new subscriber unchanged", () => {
    const order = subOrder("500", 1);
    expect(orderTypeOf(order, { isFirstSubscriptionOrder: isFirstSubscriptionOrder(order, null) })).toBe("subscription_checkout");
  });
});

describe("foldOrders seeds firstSubscriptionOrder oldest-first", () => {
  const gql = (id, day, sub) => ({
    id: `gid://shopify/Order/${id}`,
    createdAt: `${day}T10:00:00Z`,
    totalPrice: 50,
    customer: { id: "gid://shopify/Customer/77" },
    lineItems: sub ? [{ sellingPlan: { name: "Every 28 days" } }] : [{ sellingPlan: null }],
  });

  test("the earliest subscription order wins, and one-offs before it are ignored", () => {
    const { firstSubscriptionOrder } = foldOrders([
      gql(1, "2026-01-01", false), // one-off first
      gql(2, "2026-02-01", true), // ← acquiring subscription checkout
      gql(3, "2026-03-01", true), // renewal
    ]);
    expect(firstSubscriptionOrder.get("77")).toBe("2");
  });

  test("a customer with no subscription order gets no entry", () => {
    const { firstSubscriptionOrder } = foldOrders([gql(1, "2026-01-01", false)]);
    expect(firstSubscriptionOrder.has("77")).toBe(false);
  });
});
