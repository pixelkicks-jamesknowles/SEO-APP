import { redactEvent } from "../app/lib/redact.js";

describe("redactEvent", () => {
  test("strips PII from a checkout event but keeps commerce data", () => {
    const ev = {
      name: "checkout_completed",
      id: "evt_1",
      clientId: "111.222",
      email: "buyer@example.com",
      phone: "+44 7700 900123",
      externalId: "gid://shopify/Customer/55",
      fbp: "fb.1.2.3",
      fbc: "fb.1.2.c",
      clientIp: "203.0.113.10",
      userAgent: "Mozilla/5.0",
      data: {
        checkout: {
          currencyCode: "GBP",
          totalPrice: { amount: 120 },
          email: "buyer@example.com",
          phone: "+44 7700 900123",
          shippingAddress: { firstName: "Sam", zip: "LS1 1AA" },
          billingAddress: { firstName: "Sam" },
          lineItems: [{ title: "Air Max" }],
        },
      },
    };
    const r = redactEvent(ev);
    // PII removed
    for (const k of ["email", "phone", "externalId", "fbp", "fbc", "clientIp", "userAgent"]) {
      expect(r[k]).toBeUndefined();
    }
    expect(r.data.checkout.email).toBeUndefined();
    expect(r.data.checkout.shippingAddress).toBeUndefined();
    expect(r.data.checkout.billingAddress).toBeUndefined();
    // Non-PII kept
    expect(r.name).toBe("checkout_completed");
    expect(r.clientId).toBe("111.222"); // pseudonymous analytics id, retained
    expect(r.data.checkout.currencyCode).toBe("GBP");
    expect(r.data.checkout.lineItems).toHaveLength(1);
    // Original object not mutated
    expect(ev.email).toBe("buyer@example.com");
  });

  test("handles events with no data", () => {
    expect(redactEvent({ name: "scroll", params: { percent_scrolled: 50 } })).toEqual({ name: "scroll", params: { percent_scrolled: 50 } });
    expect(redactEvent(null)).toBeNull();
  });
});
