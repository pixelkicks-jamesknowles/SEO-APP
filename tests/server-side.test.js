import {
  fanOutServerSide,
  ga4EventFor,
  metaEventFor,
  extractCommerce,
  parseGaClientId,
  stableClientId,
  sha256Hex,
} from "../app/lib/server-side.server.js";

const lastBody = (call) => JSON.parse(call[1].body);

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});
afterEach(() => {
  global.fetch = undefined;
});

// A representative checkout_completed event payload (Shopify Web Pixels shape).
const checkoutEvent = {
  name: "checkout_completed",
  id: "evt_123",
  timestamp: "2026-06-26T10:00:00.000Z",
  data: {
    checkout: {
      currencyCode: "GBP",
      totalPrice: { amount: 120, currencyCode: "GBP" },
      order: { id: "5500000000001" },
      email: "Buyer@Example.com ",
      phone: "+44 7700 900123",
      lineItems: [
        { quantity: 2, title: "Air Max", variant: { sku: "AM-9", title: "UK 9", price: { amount: 60, currencyCode: "GBP" }, product: { id: "p1", title: "Air Max", vendor: "Nike", type: "Shoes" } } },
      ],
    },
  },
  context: { document: { location: { href: "https://shop.example.com/checkout" } } },
};

const matrixAll = JSON.stringify({
  ga4: ["page_viewed", "checkout_completed"],
  meta: ["checkout_completed"],
  gtm: ["checkout_completed"],
});

describe("pure builders", () => {
  test("parseGaClientId extracts the client id from a _ga cookie", () => {
    expect(parseGaClientId("GA1.1.1234567890.1700000000")).toBe("1234567890.1700000000");
    expect(parseGaClientId("GA1.2.987.654")).toBe("987.654");
    expect(parseGaClientId("garbage")).toBeNull();
    expect(parseGaClientId(undefined)).toBeNull();
  });

  test("stableClientId is deterministic and contains no randomness", () => {
    expect(stableClientId("order-1")).toBe(stableClientId("order-1"));
    expect(stableClientId("a")).not.toBe(stableClientId("b"));
  });

  test("sha256Hex normalizes (trim + lowercase) before hashing", () => {
    expect(sha256Hex(" Buyer@Example.com ")).toBe(sha256Hex("buyer@example.com"));
    expect(sha256Hex("")).toBeNull();
  });

  test("extractCommerce reads value/currency/items/transaction_id from a checkout", () => {
    const c = extractCommerce("checkout_completed", checkoutEvent.data);
    expect(c.value).toBe(120);
    expect(c.currency).toBe("GBP");
    expect(c.transactionId).toBe("5500000000001");
    expect(c.items).toHaveLength(1);
    expect(c.items[0]).toMatchObject({ item_id: "AM-9", quantity: 2, price: 60 });
  });
});

describe("ga4EventFor", () => {
  test("maps checkout_completed → purchase with transaction_id + items (GA4 de-dup key)", () => {
    const ev = ga4EventFor("checkout_completed", checkoutEvent);
    expect(ev.name).toBe("purchase");
    expect(ev.params.transaction_id).toBe("5500000000001");
    expect(ev.params.value).toBe(120);
    expect(ev.params.currency).toBe("GBP");
    expect(ev.params.items).toHaveLength(1);
  });
});

describe("metaEventFor", () => {
  test("sets event_id (dedup), hashed user data and custom_data", () => {
    const ev = metaEventFor("checkout_completed", { ...checkoutEvent, fbp: "fb.1.2.3", clientIp: "1.2.3.4", userAgent: "UA" });
    expect(ev.event_name).toBe("Purchase");
    expect(ev.event_id).toBe("evt_123");
    expect(ev.user_data.em).toEqual([sha256Hex("buyer@example.com")]);
    expect(ev.user_data.fbp).toBe("fb.1.2.3");
    expect(ev.user_data.client_ip_address).toBe("1.2.3.4");
    expect(ev.custom_data.value).toBe(120);
    expect(ev.custom_data.contents).toHaveLength(1);
    expect(ev.custom_data.order_id).toBe("5500000000001");
  });
});

describe("fanOutServerSide", () => {
  test("no-op when serverSide is off", async () => {
    await fanOutServerSide({ serverSide: false, eventMatrix: matrixAll }, checkoutEvent);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("fires GA4 + Meta when both are configured and opted into the event", async () => {
    const settings = {
      serverSide: true,
      ga4Id: "G-1",
      metaPixelId: "P-1",
      eventMatrix: matrixAll,
      serverSideKeys: JSON.stringify({ ga4ApiSecret: "s", metaCapiToken: "t" }),
    };
    await fanOutServerSide(settings, checkoutEvent);
    const urls = global.fetch.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes("google-analytics.com/mp/collect"))).toBe(true);
    expect(urls.some((u) => u.includes("graph.facebook.com"))).toBe(true);
  });

  test("does NOT fire a platform that isn't opted into the event in the matrix", async () => {
    const settings = {
      serverSide: true,
      ga4Id: "G-1",
      eventMatrix: JSON.stringify({ ga4: ["page_viewed"] }), // checkout not opted in
      serverSideKeys: JSON.stringify({ ga4ApiSecret: "s" }),
    };
    await fanOutServerSide(settings, checkoutEvent);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("uses the _ga client_id from the event when present", async () => {
    const settings = {
      serverSide: true,
      ga4Id: "G-1",
      eventMatrix: matrixAll,
      serverSideKeys: JSON.stringify({ ga4ApiSecret: "s" }),
    };
    await fanOutServerSide(settings, { ...checkoutEvent, clientId: "111.222" });
    expect(lastBody(global.fetch.mock.calls[0]).client_id).toBe("111.222");
  });

  test("forwards GTM events to the server-side GTM container's GA4 client", async () => {
    const settings = {
      serverSide: true,
      gtmId: "GTM-XYZ",
      ga4Id: "G-1",
      eventMatrix: JSON.stringify({ gtm: ["checkout_completed"] }),
      serverSideKeys: JSON.stringify({ ga4ApiSecret: "s", gtmServerUrl: "https://sgtm.example.com/" }),
    };
    await fanOutServerSide(settings, checkoutEvent);
    const urls = global.fetch.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.startsWith("https://sgtm.example.com/g/collect"))).toBe(true);
  });
});
