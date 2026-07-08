import { buildRefundEvent, buildCancellationEvent, buildSubscriptionRefundEvent, buildSubscriptionCancellationEvent } from "../app/lib/refund.js";
import { isBot } from "../app/lib/server-side.server.js";

describe("buildRefundEvent", () => {
  test("builds a GA4 refund from a partial refund payload", () => {
    const refund = {
      order_id: 5500000000001,
      transactions: [{ amount: "24.00", currency: "GBP", kind: "refund" }],
      refund_line_items: [{ quantity: 1, line_item: { sku: "AM-9", title: "Air Max", price: "24.00" } }],
    };
    const ev = buildRefundEvent(refund, { clientId: "111.222" });
    expect(ev.name).toBe("refund");
    expect(ev.params.transaction_id).toBe("5500000000001");
    expect(ev.params.value).toBe(24);
    expect(ev.params.currency).toBe("GBP");
    expect(ev.params.items).toHaveLength(1);
    expect(ev.params.items[0]).toMatchObject({ item_id: "AM-9", quantity: 1, price: 24 });
    // Non-subscription line → tagged numeric 0 (never "(not set)" on the refund path).
    expect(ev.params.items[0].item_subscription).toBe(0);
    expect(ev.params.items[0].item_subscription_interval).toBe(0);
    expect(ev.clientId).toBe("111.222");
  });

  test("sums multiple refund transactions", () => {
    const ev = buildRefundEvent({
      order_id: 7,
      transactions: [{ amount: "10.00", currency: "USD", kind: "refund" }, { amount: "5.50", currency: "USD", kind: "refund" }],
    });
    expect(ev.params.value).toBe(15.5);
  });

  test("excludes pending / failed refund transactions (money not actually returned)", () => {
    const ev = buildRefundEvent({
      order_id: 8,
      transactions: [
        { amount: "10.00", currency: "USD", kind: "refund", status: "success" },
        { amount: "5.00", currency: "USD", kind: "refund", status: "pending" },
        { amount: "3.00", currency: "USD", kind: "refund", status: "failure" },
      ],
    });
    expect(ev.params.value).toBe(10); // only the settled refund counts
  });

  test("uses the shop's fallback currency (not a blind USD) when a sparse payload omits currency", () => {
    // A refund payload with no transaction currency, on a GBP-reporting store.
    const ev = buildRefundEvent({ order_id: 8, transactions: [] }, { fallbackCurrency: "GBP" });
    expect(ev.params.currency).toBe("GBP");
    // With neither a payload currency nor a fallback, USD remains the last-resort default.
    expect(buildRefundEvent({ order_id: 8, transactions: [] }, {}).params.currency).toBe("USD");
  });
});

describe("buildCancellationEvent", () => {
  test("builds a full refund from a cancelled order", () => {
    const order = { id: 9, currency: "GBP", current_total_price: "48.00", line_items: [{ sku: "X", title: "Item", price: "24.00", quantity: 2 }] };
    const ev = buildCancellationEvent(order, { clientId: "c.1" });
    expect(ev.name).toBe("refund");
    expect(ev.params.transaction_id).toBe("9");
    expect(ev.params.value).toBe(48);
    expect(ev.params.items).toHaveLength(1);
  });
});

describe("buildSubscriptionRefundEvent", () => {
  test("reverses only the subscription line(s) of a mixed refund", () => {
    const refund = {
      order_id: 100,
      transactions: [{ amount: "29.80", currency: "GBP", kind: "refund" }],
      refund_line_items: [
        { quantity: 2, subtotal: "20.00", line_item: { sku: "SUB", title: "Coffee", price: "10.00", selling_plan_allocation: { selling_plan: { name: "Monthly" } } } },
        { quantity: 1, subtotal: "9.80", line_item: { sku: "OTP", title: "Mug", price: "9.80" } },
      ],
    };
    const ev = buildSubscriptionRefundEvent(refund, { clientId: "c.1" });
    expect(ev.name).toBe("subscription_refund");
    expect(ev.params.transaction_id).toBe("100");
    expect(ev.params.value).toBe(20); // subscription line subtotal only, excludes the Mug
    expect(ev.params.currency).toBe("GBP");
    expect(ev.params.items).toHaveLength(1);
    expect(ev.params.items[0].item_id).toBe("SUB");
    // Subscription line → tagged numeric 1 (consistent with the purchase builders), interval from the plan name.
    expect(ev.params.items[0].item_subscription).toBe(1);
    expect(ev.params.items[0].item_subscription_interval).toBe(28); // "Monthly" → 28 (client default monthDays)
  });

  test("custom event name; falls back to price×qty when no subtotal", () => {
    const refund = {
      order_id: 7,
      refund_line_items: [{ quantity: 3, line_item: { sku: "SUB", price: "4.00", selling_plan_allocation: { selling_plan: { name: "Weekly" } } } }],
    };
    const ev = buildSubscriptionRefundEvent(refund, { eventName: "sub_refund" });
    expect(ev.name).toBe("sub_refund");
    expect(ev.params.value).toBe(12); // 4.00 * 3
  });

  test("returns null when nothing subscription-related was refunded", () => {
    const refund = { order_id: 9, refund_line_items: [{ quantity: 1, line_item: { sku: "OTP", price: "5.00" } }] };
    expect(buildSubscriptionRefundEvent(refund, {})).toBeNull();
  });
});

describe("buildSubscriptionCancellationEvent", () => {
  test("reverses the subscription lines of a cancelled order", () => {
    const order = {
      id: 55,
      currency: "USD",
      line_items: [
        { sku: "SUB", title: "Box", price: "30.00", quantity: 1, total_discount: "5.00", selling_plan_allocation: { selling_plan: { name: "Monthly" } } },
        { sku: "OTP", title: "Card", price: "2.00", quantity: 1 },
      ],
    };
    const ev = buildSubscriptionCancellationEvent(order, { clientId: "c.2" });
    expect(ev.name).toBe("subscription_refund");
    expect(ev.params.transaction_id).toBe("55");
    expect(ev.params.value).toBe(25); // 30.00 - 5.00 discount, subscription line only
    expect(ev.params.items).toHaveLength(1);
  });

  test("returns null for an order with no subscription line", () => {
    expect(buildSubscriptionCancellationEvent({ id: 1, line_items: [{ sku: "X", price: "1", quantity: 1 }] }, {})).toBeNull();
  });
});

describe("isBot", () => {
  test("flags common bots / headless agents", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isBot("facebookexternalhit/1.1")).toBe(true);
    expect(isBot("HeadlessChrome/120.0")).toBe(true);
    expect(isBot("curl/8.4.0")).toBe(true);
    expect(isBot("Mozilla/5.0 (compatible; AhrefsBot/7.0)")).toBe(true);
  });
  test("does not flag a normal browser, or empty UA", () => {
    expect(isBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")).toBe(false);
    expect(isBot("")).toBe(false);
    expect(isBot(undefined)).toBe(false);
  });
});
