import { checkoutLineVariants, orderCost, fetchVariantCosts, resolveOrderCost, cogsEnabled, __resetCogsCache } from "../app/lib/cogs.server.js";
import { withValueMode, buildJobs } from "../app/lib/server-side.server.js";

const checkoutEvent = (variants) => ({
  name: "checkout_completed",
  id: "order:9001",
  data: {
    checkout: {
      currencyCode: "USD",
      totalPrice: { amount: 100, currencyCode: "USD" },
      order: { id: "9001" },
      lineItems: variants.map((v) => ({ quantity: v.quantity, variant: { id: v.variantId, price: { amount: v.price, currencyCode: "USD" }, product: { id: "p", title: "T" } } })),
    },
  },
});

// A minimal Admin GraphQL client stub whose nodes() returns unitCost for the variant ids requested.
const adminReturning = (costByVariant) => ({
  graphql: jest.fn(async (_q, { variables }) => ({
    json: async () => ({
      data: {
        nodes: variables.ids.map((gid) => {
          const id = gid.match(/\d+/g).pop();
          const amount = costByVariant[id];
          return amount == null ? { id: gid } : { id: gid, inventoryItem: { unitCost: { amount: String(amount) } } };
        }),
      },
    }),
  })),
});

beforeEach(() => __resetCogsCache());

describe("cogsEnabled", () => {
  test("only true for the cogs value mode", () => {
    expect(cogsEnabled({ valueMode: "cogs" })).toBe(true);
    expect(cogsEnabled({ valueMode: "margin" })).toBe(false);
    expect(cogsEnabled({})).toBe(false);
  });
});

describe("checkoutLineVariants + orderCost", () => {
  test("extracts numeric variant ids + quantities and sums qty × unit cost", () => {
    const ev = checkoutEvent([{ variantId: "111", quantity: 2, price: 30 }, { variantId: "222", quantity: 1, price: 40 }]);
    expect(checkoutLineVariants(ev)).toEqual([{ variantId: "111", quantity: 2 }, { variantId: "222", quantity: 1 }]);
    const costMap = new Map([["111", 12], ["222", 15]]);
    expect(orderCost(ev, costMap)).toBe(39); // 2×12 + 1×15
  });

  test("returns null when no line's cost resolves (so caller keeps revenue)", () => {
    const ev = checkoutEvent([{ variantId: "111", quantity: 1, price: 30 }]);
    expect(orderCost(ev, new Map())).toBeNull();
  });

  test("sums only the resolved lines when cost is partial", () => {
    const ev = checkoutEvent([{ variantId: "111", quantity: 1, price: 30 }, { variantId: "222", quantity: 2, price: 40 }]);
    expect(orderCost(ev, new Map([["111", 10]]))).toBe(10); // 222 has no cost → excluded
  });
});

describe("fetchVariantCosts", () => {
  test("fetches misses once, caches results (incl. no-cost misses), returns a numeric map", async () => {
    const admin = adminReturning({ "111": 12, "222": null });
    const first = await fetchVariantCosts("s.myshopify.com", ["111", "222"], { admin });
    expect(first.get("111")).toBe(12);
    expect(first.has("222")).toBe(false); // no cost set → absent
    // Second call is fully served from cache — no extra Admin call.
    const second = await fetchVariantCosts("s.myshopify.com", ["111", "222"], { admin });
    expect(second.get("111")).toBe(12);
    expect(admin.graphql).toHaveBeenCalledTimes(1);
  });

  test("a fetch failure degrades to an empty map (never throws)", async () => {
    const admin = { graphql: jest.fn().mockRejectedValue(new Error("boom")) };
    const map = await fetchVariantCosts("s.myshopify.com", ["111"], { admin });
    expect(map.size).toBe(0);
  });
});

describe("resolveOrderCost", () => {
  test("resolves an order's total cost of goods via the Admin client", async () => {
    const ev = checkoutEvent([{ variantId: "111", quantity: 3, price: 30 }]);
    const admin = adminReturning({ "111": 8 });
    expect(await resolveOrderCost("s.myshopify.com", ev, { admin })).toBe(24);
  });
});

describe("withValueMode cogs branch", () => {
  test("value becomes revenue − cost, raw kept as revenue", () => {
    const t = { value: 100, currency: "USD" };
    withValueMode(t, "cogs", 0, 62);
    expect(t.value).toBe(38);
    expect(t.revenue).toBe(100);
  });

  test("clamps a below-cost order at 0 (never a negative conversion value)", () => {
    const t = { value: 20 };
    withValueMode(t, "cogs", 0, 30);
    expect(t.value).toBe(0);
  });

  test("no resolved cost falls back to revenue (no mutation)", () => {
    const t = { value: 100 };
    withValueMode(t, "cogs", 0, undefined);
    expect(t.value).toBe(100);
    expect(t.revenue).toBeUndefined();
  });
});

describe("buildJobs applies COGS profit to the purchase value across destinations", () => {
  const settings = {
    shopDomain: "s.myshopify.com",
    serverSide: true,
    valueMode: "cogs",
    ga4Id: "G-1",
    metaPixelId: "PIX",
    serverSideKeys: JSON.stringify({ ga4ApiSecret: "s", metaCapiToken: "t" }),
    eventMatrix: JSON.stringify({ ga4: ["checkout_completed"], meta: ["checkout_completed"] }),
  };

  test("event.orderCost drives value = revenue − cost on the GA4 + Meta purchase jobs", () => {
    const ev = { ...checkoutEvent([{ variantId: "111", quantity: 1, price: 100 }]), orderCost: 62 };
    const jobs = buildJobs(settings, ev);
    const ga4 = jobs.find((j) => j.destination === "ga4");
    const meta = jobs.find((j) => j.destination === "meta");
    expect(ga4.event.params.value).toBe(38);
    expect(ga4.event.params.revenue).toBe(100);
    expect(meta.event.custom_data.value).toBe(38);
  });

  test("no orderCost → the purchase keeps raw revenue", () => {
    const ev = checkoutEvent([{ variantId: "111", quantity: 1, price: 100 }]);
    const ga4 = buildJobs(settings, ev).find((j) => j.destination === "ga4");
    expect(ga4.event.params.value).toBe(100);
    expect(ga4.event.params.revenue).toBeUndefined();
  });
});
