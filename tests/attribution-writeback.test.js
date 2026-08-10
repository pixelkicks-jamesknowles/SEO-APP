import { orderTypeOf, customerTypeOf, rechargeOrderType, buildSubscriptionEvent, buildOrderPurchaseEvent } from "../app/lib/subscription.js";
import { attributionValues, buildMetafields, ORDER_DEFS, CUSTOMER_DEFS, writeOrderAttribution, writeCustomerAttribution, provisionDefinitions } from "../app/lib/report-writeback.server.js";
import { byAcquisition } from "../app/lib/attribution-report.js";

const subLine = { selling_plan_allocation: { selling_plan: { id: 1, name: "Monthly" } } };
const oneOffLine = { title: "Tee" };

describe("rechargeOrderType", () => {
  test("reads the note_attribute marker (preferred)", () => {
    expect(rechargeOrderType({ note_attributes: [{ name: "subscription_order_type", value: "checkout_subscription" }] })).toBe("checkout_subscription");
    expect(rechargeOrderType({ note_attributes: [{ name: "subscription_order_type", value: "recurring_subscription" }] })).toBe("recurring_subscription");
  });
  test("falls back to order tags", () => {
    expect(rechargeOrderType({ tags: "vip, Subscription Recurring Order" })).toBe("recurring_subscription");
    expect(rechargeOrderType({ tags: "Subscription First Order" })).toBe("checkout_subscription");
  });
  test("null when absent", () => {
    expect(rechargeOrderType({ tags: "vip", note_attributes: [] })).toBeNull();
    expect(rechargeOrderType({})).toBeNull();
  });
});

describe("orderTypeOf", () => {
  test("one-off when no subscription line", () => {
    expect(orderTypeOf({ line_items: [oneOffLine] })).toBe("one_off");
  });
  test("Recharge marker wins over inference", () => {
    // Marked as a renewal even though we'd otherwise call a first sub order a checkout.
    const order = { line_items: [subLine], note_attributes: [{ name: "subscription_order_type", value: "recurring_subscription" }] };
    expect(orderTypeOf(order, { isFirstSubscriptionOrder: true })).toBe("renewal");
  });
  test("first subscription order → checkout, later → renewal", () => {
    expect(orderTypeOf({ line_items: [subLine] }, { isFirstSubscriptionOrder: true })).toBe("subscription_checkout");
    expect(orderTypeOf({ line_items: [subLine] }, { isFirstSubscriptionOrder: false })).toBe("renewal");
  });
});

describe("customerTypeOf", () => {
  test("uses orders_count when present (authoritative)", () => {
    expect(customerTypeOf({ customer: { orders_count: 1 } })).toBe("new");
    expect(customerTypeOf({ customer: { orders_count: 4 } })).toBe("returning");
  });
  test("falls back to isFirstOrder when count absent", () => {
    expect(customerTypeOf({}, { isFirstOrder: true })).toBe("new");
    expect(customerTypeOf({}, { isFirstOrder: false })).toBe("returning");
  });
  test("null when nothing to go on", () => {
    expect(customerTypeOf({})).toBeNull();
  });
});

describe("GA4 events carry order_type / customer_type", () => {
  const order = { id: 99, currency: "GBP", current_total_price: "50.00", line_items: [subLine] };
  test("subscription_purchase event", () => {
    const ev = buildSubscriptionEvent(order, { orderType: "subscription_checkout", customerType: "new" });
    expect(ev.params.order_type).toBe("subscription_checkout");
    expect(ev.params.customer_type).toBe("new");
  });
  test("purchase event", () => {
    const ev = buildOrderPurchaseEvent(order, { orderType: "renewal", customerType: "returning" });
    expect(ev.params.order_type).toBe("renewal");
    expect(ev.params.customer_type).toBe("returning");
  });
  test("omitted params are not set", () => {
    const ev = buildOrderPurchaseEvent(order, {});
    expect(ev.params.order_type).toBeUndefined();
    expect(ev.params.customer_type).toBeUndefined();
  });
});

describe("attributionValues", () => {
  test("derives source_medium and channel from the first-touch pair", () => {
    const v = attributionValues({ source: "google", medium: "cpc", campaign: "brand", orderType: "one_off", customerType: "new", acquisitionDate: "2026-01-15T10:00:00Z" });
    expect(v.sourceMedium).toBe("google / cpc");
    expect(v.channel).toBe("Paid Search");
    expect(v.acquisitionDate).toBe("2026-01-15"); // YYYY-MM-DD
    expect(v.campaign).toBe("brand");
  });
  test("null source/medium → no source_medium or channel (don't invent (direct))", () => {
    const v = attributionValues({ orderType: "one_off" });
    expect(v.sourceMedium).toBeNull();
    expect(v.channel).toBeNull();
    expect(v.acquisitionDate).toBeNull();
  });
});

describe("buildMetafields", () => {
  const values = attributionValues({ source: "klaviyo", medium: "email", orderType: "renewal", customerType: "returning" });
  test("builds one input per non-empty order field, under the connect_analytics namespace", () => {
    const mfs = buildMetafields("gid://shopify/Order/1", ORDER_DEFS, values);
    expect(mfs.every((m) => m.namespace === "connect_analytics")).toBe(true);
    expect(mfs.every((m) => m.ownerId === "gid://shopify/Order/1")).toBe(true);
    const keys = mfs.map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(["source", "medium", "source_medium", "channel", "order_type", "customer_type"]));
    // campaign was null → skipped (never write a blank).
    expect(keys).not.toContain("campaign");
    expect(keys).not.toContain("acquisition_date");
  });
  test("customer defs map to acquisition_* keys", () => {
    const mfs = buildMetafields("gid://shopify/Customer/1", CUSTOMER_DEFS, values);
    expect(mfs.map((m) => m.key)).toEqual(expect.arrayContaining(["acquisition_channel", "acquisition_source_medium"]));
  });
});

// Minimal fake Admin GraphQL client: returns whatever `respond` yields, and records the calls.
function fakeAdmin(respond) {
  const calls = [];
  return {
    calls,
    graphql: async (query, opts) => {
      calls.push({ query, variables: opts?.variables });
      return { json: async () => respond(query, opts) };
    },
  };
}

describe("writeOrderAttribution / writeCustomerAttribution", () => {
  const values = attributionValues({ source: "google", medium: "cpc", orderType: "one_off", customerType: "new" });

  test("skips cleanly when the order id can't be parsed", async () => {
    const admin = fakeAdmin(() => ({}));
    const r = await writeOrderAttribution(admin, null, values);
    expect(r).toEqual({ ok: false, skipped: true });
    expect(admin.calls.length).toBe(0);
  });

  test("ok path sends one metafieldsSet with the order GID", async () => {
    const admin = fakeAdmin(() => ({ data: { metafieldsSet: { userErrors: [] } } }));
    const r = await writeOrderAttribution(admin, "gid://shopify/Order/123", values);
    expect(r.ok).toBe(true);
    expect(admin.calls[0].variables.metafields[0].ownerId).toBe("gid://shopify/Order/123");
  });

  test("surfaces userErrors as not-ok", async () => {
    const admin = fakeAdmin(() => ({ data: { metafieldsSet: { userErrors: [{ message: "bad" }] } } }));
    const r = await writeOrderAttribution(admin, 123, values);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
  });

  test("detects throttling from top-level errors", async () => {
    const admin = fakeAdmin(() => ({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }));
    const r = await writeOrderAttribution(admin, 123, values);
    expect(r.ok).toBe(false);
    expect(r.throttled).toBe(true);
  });

  test("customer write targets the customer GID", async () => {
    const admin = fakeAdmin(() => ({ data: { metafieldsSet: { userErrors: [] } } }));
    const r = await writeCustomerAttribution(admin, "gid://shopify/Customer/9", values);
    expect(r.ok).toBe(true);
    expect(admin.calls[0].variables.metafields[0].ownerId).toBe("gid://shopify/Customer/9");
  });
});

describe("provisionDefinitions", () => {
  test("creates order + customer definitions, swallowing already-exists", async () => {
    let n = 0;
    const admin = fakeAdmin(() => {
      n += 1;
      // First one 'already taken' (no createdDefinition), the rest succeed.
      return n === 1
        ? { data: { metafieldDefinitionCreate: { createdDefinition: null, userErrors: [{ code: "TAKEN" }] } } }
        : { data: { metafieldDefinitionCreate: { createdDefinition: { id: `gid://def/${n}` }, userErrors: [] } } };
    });
    const r = await provisionDefinitions(admin);
    expect(admin.calls.length).toBe(ORDER_DEFS.length + CUSTOMER_DEFS.length);
    expect(r.created).toBe(ORDER_DEFS.length + CUSTOMER_DEFS.length - 1);
  });

  test("a throwing call doesn't abort the rest", async () => {
    const admin = {
      graphql: async () => {
        throw new Error("network");
      },
    };
    const r = await provisionDefinitions(admin);
    expect(r.created).toBe(0); // all failed, but it returned rather than threw
  });
});

describe("byAcquisition", () => {
  const rows = [
    { source: "google", medium: "cpc", campaign: "brand", orderType: "subscription_checkout", customerType: "new", orders: 3, revenue: 300 },
    { source: "google", medium: "cpc", campaign: "brand", orderType: "renewal", customerType: "returning", orders: 5, revenue: 250 },
    { source: "(direct)", medium: "(none)", campaign: "(none)", orderType: "one_off", customerType: "new", orders: 2, revenue: 80 },
  ];
  test("rolls up per channel+campaign with the splits", () => {
    const { rows: out, totalNewSubscribers, totalNewCustomers } = byAcquisition(rows);
    const g = out.find((r) => r.source === "google");
    expect(g.orders).toBe(8);
    expect(g.revenue).toBe(550);
    expect(g.newSubscribers).toBe(3);
    expect(g.renewals).toBe(5);
    expect(g.newCustomers).toBe(3); // the 3 subscription_checkout orders were customerType new
    expect(totalNewSubscribers).toBe(3);
    expect(totalNewCustomers).toBe(5); // 3 google + 2 direct one-off
  });
  test("sorted by revenue desc + share computed", () => {
    const { rows: out } = byAcquisition(rows);
    expect(out[0].source).toBe("google");
    expect(out[0].share).toBe(87); // 550 / 630
  });
});
