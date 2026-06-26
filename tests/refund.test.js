import { buildRefundEvent, buildCancellationEvent } from "../app/lib/refund.js";
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
    expect(ev.clientId).toBe("111.222");
  });

  test("sums multiple refund transactions", () => {
    const ev = buildRefundEvent({
      order_id: 7,
      transactions: [{ amount: "10.00", currency: "USD", kind: "refund" }, { amount: "5.50", currency: "USD", kind: "refund" }],
    });
    expect(ev.params.value).toBe(15.5);
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
