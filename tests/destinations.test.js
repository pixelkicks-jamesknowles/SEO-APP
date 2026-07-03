import {
  tiktokEventFor,
  pinterestEventFor,
  metaIdentifierKeys,
  metaUserData,
  buildJobs,
  deliverOne,
  sha256Hex,
} from "../app/lib/server-side.server.js";

const checkoutEvent = {
  name: "checkout_completed",
  id: "evt_123",
  timestamp: "2026-07-03T10:00:00.000Z",
  clientIp: "203.0.113.7",
  userAgent: "Mozilla/5.0",
  data: {
    checkout: {
      currencyCode: "USD",
      totalPrice: { amount: 120, currencyCode: "USD" },
      order: { id: "5500000000001" },
      email: "Buyer@Example.com",
      phone: "+1 (415) 555-0100",
      shippingAddress: { firstName: "Sam", lastName: "Jones", city: "Reno", provinceCode: "NV", zip: "89501", countryCode: "US" },
      lineItems: [
        { quantity: 2, title: "Air Max", variant: { sku: "AM-9", title: "9", price: { amount: 60, currencyCode: "USD" }, product: { id: "p1", title: "Air Max" } } },
      ],
    },
  },
};

describe("tiktokEventFor", () => {
  test("maps the standard event, hashes PII, and carries commerce", () => {
    const ev = tiktokEventFor("checkout_completed", checkoutEvent);
    expect(ev.event).toBe("CompletePayment");
    expect(ev.event_id).toBe("evt_123");
    expect(ev.user.email).toBe(sha256Hex("buyer@example.com"));
    expect(ev.user.phone).toBe(sha256Hex("14155550100")); // non-digits stripped before hashing
    expect(ev.user.ip).toBe("203.0.113.7");
    expect(ev.properties.value).toBe(120);
    expect(ev.properties.currency).toBe("USD");
    expect(ev.properties.contents[0]).toMatchObject({ content_id: "AM-9", quantity: 2, price: 60 });
    expect(ev.properties.order_id).toBe("5500000000001");
  });

  test("an unmapped event passes through as a custom TikTok event name", () => {
    expect(tiktokEventFor("page_viewed", { name: "page_viewed" }).event).toBe("page_viewed");
  });
});

describe("pinterestEventFor", () => {
  test("maps to checkout, hashes PII into arrays, value is a string", () => {
    const ev = pinterestEventFor("checkout_completed", checkoutEvent);
    expect(ev.event_name).toBe("checkout");
    expect(ev.action_source).toBe("web");
    expect(ev.user_data.em).toEqual([sha256Hex("buyer@example.com")]);
    expect(ev.custom_data.value).toBe("120");
    expect(ev.custom_data.content_ids).toEqual(["AM-9"]);
    expect(ev.custom_data.num_items).toBe(2);
    expect(ev.custom_data.order_id).toBe("5500000000001");
  });

  test("an unmapped event falls back to the Pinterest 'custom' event", () => {
    expect(pinterestEventFor("checkout_started", { name: "checkout_started" }).event_name).toBe("custom");
  });
});

describe("metaIdentifierKeys", () => {
  test("reports exactly the identifiers a user_data block carries", () => {
    const keys = metaIdentifierKeys(metaUserData(checkoutEvent));
    expect(keys).toEqual(expect.arrayContaining(["em", "ph", "fn", "ln", "ct", "st", "zp", "country", "clientIp", "userAgent"]));
    expect(keys).not.toContain("fbp"); // no _fbp cookie on this event
  });

  test("empty for an event with no identifiers", () => {
    expect(metaIdentifierKeys(metaUserData({ name: "page_viewed", data: {} }))).toEqual([]);
  });
});

describe("buildJobs wiring", () => {
  const base = {
    shopDomain: "s.myshopify.com",
    serverSide: true,
    tiktokPixelId: "C4ABC",
    pinterestId: "2612345",
    eventMatrix: JSON.stringify({ tiktok: ["checkout_completed"], pinterest: ["checkout_completed"] }),
  };

  test("adds a TikTok job only when the pixel id + access token are both present", () => {
    const withToken = { ...base, serverSideKeys: JSON.stringify({ tiktokAccessToken: "tok" }) };
    expect(buildJobs(withToken, checkoutEvent).some((j) => j.destination === "tiktok")).toBe(true);
    const noToken = { ...base, serverSideKeys: JSON.stringify({}) };
    expect(buildJobs(noToken, checkoutEvent).some((j) => j.destination === "tiktok")).toBe(false);
  });

  test("adds a Pinterest job only with tag id + token + ad account id", () => {
    const full = { ...base, serverSideKeys: JSON.stringify({ pinterestAccessToken: "tok", pinterestAdAccountId: "549" }) };
    expect(buildJobs(full, checkoutEvent).some((j) => j.destination === "pinterest")).toBe(true);
    const noAcct = { ...base, serverSideKeys: JSON.stringify({ pinterestAccessToken: "tok" }) };
    expect(buildJobs(noAcct, checkoutEvent).some((j) => j.destination === "pinterest")).toBe(false);
  });

  test("marketing-consent-declined suppresses TikTok/Pinterest (they carry PII)", () => {
    const full = { ...base, serverSideKeys: JSON.stringify({ tiktokAccessToken: "t", pinterestAccessToken: "t", pinterestAdAccountId: "1" }) };
    const declined = { ...checkoutEvent, consent: { analytics: true, marketing: false } };
    const dests = buildJobs(full, declined).map((j) => j.destination);
    expect(dests).not.toContain("tiktok");
    expect(dests).not.toContain("pinterest");
  });
});

describe("deliverOne routing", () => {
  afterEach(() => (global.fetch = undefined));

  test("tiktok posts to the Events API with the Access-Token header", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const settings = { tiktokPixelId: "C4ABC", serverSideKeys: JSON.stringify({ tiktokAccessToken: "tok" }) };
    const r = await deliverOne(settings, { destination: "tiktok", event: { event: "CompletePayment" } });
    expect(r.ok).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toContain("business-api.tiktok.com");
    expect(global.fetch.mock.calls[0][1].headers["Access-Token"]).toBe("tok");
  });

  test("pinterest posts under the ad account with a Bearer token", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const settings = { pinterestId: "261", serverSideKeys: JSON.stringify({ pinterestAccessToken: "tok", pinterestAdAccountId: "549" }) };
    const r = await deliverOne(settings, { destination: "pinterest", event: { event_name: "checkout" } });
    expect(r.ok).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toContain("/ad_accounts/549/events");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  test("unconfigured destinations report a clean reason (no throw)", async () => {
    expect(await deliverOne({}, { destination: "tiktok", event: {} })).toMatchObject({ ok: false });
    expect(await deliverOne({}, { destination: "pinterest", event: {} })).toMatchObject({ ok: false });
  });
});
