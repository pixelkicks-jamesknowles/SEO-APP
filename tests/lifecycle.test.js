import { buildFulfillmentEvent, buildOrderEditedEvent } from "../app/lib/lifecycle.js";

describe("buildFulfillmentEvent", () => {
  test("builds order_fulfilled from a fulfillment payload", () => {
    const ev = buildFulfillmentEvent(
      {
        order_id: 12345,
        status: "success",
        tracking_company: "DHL",
        line_items: [{ sku: "SKU-1", title: "Widget", quantity: 2, price: "9.99", variant_id: 99 }],
      },
      { clientId: "c.1" },
    );
    expect(ev.name).toBe("order_fulfilled");
    expect(ev.params.transaction_id).toBe("12345");
    expect(ev.params.shipment_status).toBe("success");
    expect(ev.params.shipping_tier).toBe("DHL");
    expect(ev.params.items).toEqual([{ item_id: "SKU-1", item_name: "Widget", quantity: 2, price: 9.99 }]);
    expect(ev.clientId).toBe("c.1");
  });

  test("falls back to variant_id for item_id and defaults status", () => {
    const ev = buildFulfillmentEvent({ order_id: 1, line_items: [{ title: "X", quantity: 1, variant_id: 42 }] });
    expect(ev.params.items[0].item_id).toBe("42");
    expect(ev.params.shipment_status).toBe("success");
  });

  test("returns null without an order id", () => {
    expect(buildFulfillmentEvent({ line_items: [] })).toBeNull();
    expect(buildFulfillmentEvent(null)).toBeNull();
  });
});

describe("buildOrderEditedEvent", () => {
  test("carries the NEW order total under a distinct event name (never 'purchase')", () => {
    const ev = buildOrderEditedEvent(
      { id: 555, current_total_price: "42.50", currency: "GBP", line_items: [{ sku: "A", title: "A", quantity: 1, price: "42.50" }] },
      { clientId: "c.2" },
    );
    expect(ev.name).toBe("order_edited");
    expect(ev.name).not.toBe("purchase");
    expect(ev.params.transaction_id).toBe("555");
    expect(ev.params.value).toBe(42.5);
    expect(ev.params.currency).toBe("GBP");
    expect(ev.params.items).toHaveLength(1);
  });

  test("prefers current_total_price, falls back to total_price, then 0", () => {
    expect(buildOrderEditedEvent({ id: 1, total_price: "10" }).params.value).toBe(10);
    expect(buildOrderEditedEvent({ id: 1 }).params.value).toBe(0);
  });

  test("returns null without an order id", () => {
    expect(buildOrderEditedEvent({ current_total_price: "5" })).toBeNull();
  });
});
