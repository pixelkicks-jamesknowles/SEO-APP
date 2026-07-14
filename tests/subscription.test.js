import {
  parseIntervalDays,
  lineIsSubscription,
  syntheticClientId,
  noteAttr,
  orderHasAnalyticsConsent,
  buildSubscriptionEvent,
  buildOrderPurchaseEvent,
  orderHasSubscription,
} from "../app/lib/subscription.js";

describe("parseIntervalDays", () => {
  test("numeric forms", () => {
    expect(parseIntervalDays("1 week: save 5%")).toBe(7);
    expect(parseIntervalDays("10 days")).toBe(10);
    expect(parseIntervalDays("2 weeks")).toBe(14);
    expect(parseIntervalDays("3 months")).toBe(84); // monthDays 28
    expect(parseIntervalDays("1 year")).toBe(365);
  });
  test("worded forms", () => {
    expect(parseIntervalDays("Weekly")).toBe(7);
    expect(parseIntervalDays("Fortnightly")).toBe(14);
    expect(parseIntervalDays("Monthly subscription")).toBe(28);
    expect(parseIntervalDays("Quarterly")).toBe(84);
    expect(parseIntervalDays("Annually")).toBe(365);
  });
  test("monthDays is configurable", () => {
    expect(parseIntervalDays("1 month", { monthDays: 30 })).toBe(30);
    expect(parseIntervalDays("monthly", { monthDays: 30 })).toBe(30);
  });
  test("unrecognised → 0", () => {
    expect(parseIntervalDays("save 5%")).toBe(0);
    expect(parseIntervalDays("")).toBe(0);
    expect(parseIntervalDays(null)).toBe(0);
  });
});

describe("lineIsSubscription", () => {
  test("REST selling_plan_allocation / GraphQL sellingPlan / neither", () => {
    expect(lineIsSubscription({ selling_plan_allocation: { selling_plan: { name: "Weekly" } } })).toBe(true);
    expect(lineIsSubscription({ sellingPlan: { name: "Weekly" } })).toBe(true);
    expect(lineIsSubscription({ sku: "X" })).toBe(false);
  });
});

describe("syntheticClientId", () => {
  test("deterministic per order + GA4 'a.b' shape", () => {
    const a = syntheticClientId(7821117129046);
    expect(a).toBe(syntheticClientId("7821117129046"));
    expect(a).toMatch(/^\d+\.\d+$/);
  });
});

describe("noteAttr / consent", () => {
  test("reads a note attribute", () => {
    const o = { note_attributes: [{ name: "ga_client_id", value: "111.222" }] };
    expect(noteAttr(o, "ga_client_id")).toBe("111.222");
    expect(noteAttr(o, "missing")).toBeNull();
  });
  test("consent heuristic = buyer_accepts_marketing", () => {
    expect(orderHasAnalyticsConsent({ buyer_accepts_marketing: true })).toBe(true);
    expect(orderHasAnalyticsConsent({ buyer_accepts_marketing: false })).toBe(false);
    expect(orderHasAnalyticsConsent({})).toBe(false);
  });
});

describe("buildSubscriptionEvent", () => {
  const order = {
    id: 7821117129046,
    currency: "GBP",
    current_total_price: "28.05",
    current_total_tax: "0.00",
    discount_codes: [{ code: "WELCOME5" }],
    line_items: [
      {
        sku: "SKU-BEEF-500",
        title: "Beef & Organic Chicken",
        variant_title: "500g pack",
        price: "2.95",
        quantity: 16,
        total_discount: "2.40",
        selling_plan_allocation: { selling_plan: { name: "1 week: save 5%" } },
      },
      { sku: "SKU-TREAT", title: "Treats", price: "5.00", quantity: 1, total_discount: "0.00" },
    ],
  };

  test("scoped to subscription lines: value = sub subtotal, coupon, order dims", () => {
    const { name, params } = buildSubscriptionEvent(order, {});
    expect(name).toBe("subscription_purchase");
    expect(params.transaction_id).toBe("7821117129046");
    // Subscription-only subtotal = beef net (2.95*16 - 2.40 = 44.80); the non-sub Treats are excluded.
    expect(params.value).toBe(44.8);
    expect(params.currency).toBe("GBP");
    expect(params.coupon).toBe("WELCOME5");
    expect(params.subscription).toBe(1);
    expect(params.subscription_interval).toBe(7); // first sub line
  });

  test("items contains only the subscription line(s)", () => {
    const { params } = buildSubscriptionEvent(order, {});
    expect(params.items).toHaveLength(1);
    const beef = params.items[0];
    expect(beef.item_id).toBe("SKU-BEEF-500");
    expect(beef.item_subscription).toBe(1);
    expect(beef.item_subscription_interval).toBe(7);
    expect(beef.price).toBe(2.8); // (2.95*16 - 2.40)/16 = 2.8
    expect(beef.discount).toBe(0.15); // 2.40/16
  });

  // session_id is what lets the server-side conversion join the shopper's real GA4 session and inherit
  // its traffic source — without it GA4 opens a source-less session and the purchase is "Unassigned".
  test("carries clientId + sessionId through to the built event", () => {
    const ev = buildSubscriptionEvent(order, { clientId: "1234567890.1700000000", sessionId: "1783409603" });
    expect(ev.clientId).toBe("1234567890.1700000000");
    expect(ev.sessionId).toBe("1783409603");
  });

  test("one-time-only order → subscription false, interval 0, empty items, zero value", () => {
    const { params } = buildSubscriptionEvent({ id: 1, currency: "GBP", current_total_price: "5.00", line_items: [{ sku: "X", price: "5.00", quantity: 1 }] }, {});
    expect(params.subscription).toBe(0);
    expect(params.subscription_interval).toBe(0);
    expect(params.items).toHaveLength(0);
    expect(params.value).toBe(0);
  });

  test("custom eventName + monthDays flow through", () => {
    const o = { id: 2, line_items: [{ sku: "M", price: "1", quantity: 1, selling_plan_allocation: { selling_plan: { name: "1 month" } } }] };
    const { name, params } = buildSubscriptionEvent(o, { eventName: "sub_buy", monthDays: 30 });
    expect(name).toBe("sub_buy");
    expect(params.subscription_interval).toBe(30);
  });

  test("Admin-API intervals override an unparseable plan name", () => {
    const o = {
      id: 3,
      line_items: [{ sku: "S", price: "10", quantity: 1, selling_plan_allocation: { selling_plan: { id: 987654, name: "Subscribe & Save" } } }],
    };
    // Name has no cadence word → parse would give 0; the resolved map wins.
    const bare = buildSubscriptionEvent(o, {});
    expect(bare.params.subscription_interval).toBe(0);
    const resolved = buildSubscriptionEvent(o, { intervals: { 987654: 7 } });
    expect(resolved.params.subscription_interval).toBe(7);
    expect(resolved.params.items[0].item_subscription_interval).toBe(7);
  });
});

describe("orderHasSubscription", () => {
  test("true when any line carries a selling plan", () => {
    expect(orderHasSubscription({ line_items: [{ sku: "A" }, { sku: "B", selling_plan_allocation: { selling_plan: { name: "Weekly" } } }] })).toBe(true);
    expect(orderHasSubscription({ line_items: [{ sku: "A" }, { sku: "B" }] })).toBe(false);
    expect(orderHasSubscription({})).toBe(false);
  });
});

describe("buildOrderPurchaseEvent", () => {
  const mixedOrder = {
    id: 42,
    currency: "GBP",
    current_total_price: "49.80",
    current_total_tax: "3.00",
    total_shipping_price_set: { shop_money: { amount: "4.00" } },
    line_items: [
      { sku: "SUB", title: "Coffee", price: "20.00", quantity: 2, total_discount: "0.00", selling_plan_allocation: { selling_plan: { name: "Monthly" } } },
      { sku: "OTP", title: "Mug", price: "9.80", quantity: 1, total_discount: "0.00" },
    ],
  };

  test("regular purchase carries the WHOLE order (all items + full value + tax/shipping)", () => {
    const { name, params } = buildOrderPurchaseEvent(mixedOrder, {});
    expect(name).toBe("purchase");
    expect(params.transaction_id).toBe("42");
    expect(params.value).toBe(49.8); // full order total, both products
    expect(params.tax).toBe(3);
    expect(params.shipping).toBe(4);
    expect(params.items).toHaveLength(2);
  });

  test("subscription_purchase for the SAME mixed order carries only the subscription product", () => {
    const { params } = buildSubscriptionEvent(mixedOrder, {});
    expect(params.items).toHaveLength(1);
    expect(params.items[0].item_id).toBe("SUB");
    expect(params.value).toBe(40); // 20.00 * 2, the subscription line only
  });
});
