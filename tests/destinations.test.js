import { ga4TimestampMicros, GA4_MAX_BACKDATE_MS } from "../app/lib/server-side.server.js";
import {
  tiktokEventFor,
  pinterestEventFor,
  klaviyoEventFor,
  snapEventFor,
  redditEventFor,
  linkedinEventFor,
  bingEventFor,
  normalizeEmail,
  normalizePhoneE164,
  checkoutHasSubscription,
  dataLayerFromGa4,
  validateGa4Event,
  validateMetaEvent,
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
    expect(ev.event_id).toBe("order:5500000000001"); // order-scoped for a purchase → dedups vs a client-side TikTok pixel
    expect(ev.user.email).toBe(sha256Hex("buyer@example.com"));
    expect(ev.user.phone).toBe(sha256Hex("+14155550100")); // E.164 with leading + (TikTok requirement)
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

describe("klaviyoEventFor", () => {
  const productView = {
    name: "product_viewed",
    id: "evt_pv1",
    timestamp: "2026-07-03T10:00:00.000Z",
    email: "Shopper@Example.com",
    externalId: "cust_9",
    context: { document: { location: { href: "https://s.example/products/tee" } } },
    data: { productVariant: { sku: "SKU1", title: "Blue", price: { amount: 40, currencyCode: "USD" }, product: { id: "p1", title: "Tee" } } },
  };

  test("maps an onsite event, attaches the profile + value + dedup id", () => {
    const a = klaviyoEventFor("product_viewed", productView).data.attributes;
    expect(a.metric.data.attributes.name).toBe("Viewed Product");
    expect(a.profile.data.attributes.email).toBe("shopper@example.com"); // lower-cased, not hashed
    expect(a.profile.data.attributes.external_id).toBe("cust_9");
    expect(a.value).toBe(40);
    expect(a.value_currency).toBe("USD");
    expect(a.unique_id).toBe("evt_pv1"); // Klaviyo dedups a replayed beacon on this
    expect(a.properties.ProductName).toBe("Tee");
  });

  test("returns null for checkout_completed (Klaviyo's native Shopify integration owns Placed Order)", () => {
    expect(klaviyoEventFor("checkout_completed", checkoutEvent)).toBeNull();
  });

  test("returns null when there is no profile identifier to attribute the event to", () => {
    const anon = { name: "product_viewed", id: "e2", data: { productVariant: { sku: "S", price: { amount: 5 }, product: { id: "p", title: "X" } } } };
    expect(klaviyoEventFor("product_viewed", anon)).toBeNull();
  });

  test("an unmapped standard event builds no body", () => {
    expect(klaviyoEventFor("page_viewed", { name: "page_viewed", email: "a@b.com" })).toBeNull();
  });
});

describe("snapEventFor", () => {
  test("maps to PURCHASE, reuses hashed PII (minus Meta cookies), value is a string", () => {
    const ev = snapEventFor("checkout_completed", checkoutEvent);
    expect(ev.event_name).toBe("PURCHASE");
    expect(ev.action_source).toBe("WEB");
    expect(ev.event_id).toBe("order:5500000000001"); // order-scoped for a purchase → dedups vs a client-side Snap pixel
    expect(ev.user_data.em).toEqual([sha256Hex("buyer@example.com")]);
    expect(ev.user_data.fbp).toBeUndefined(); // Meta-only cookie dropped
    expect(ev.custom_data.value).toBe("120"); // string
    expect(ev.custom_data.content_ids).toEqual(["AM-9"]);
    expect(ev.custom_data.order_id).toBe("5500000000001");
  });

  test("an unmapped event passes through as its own name", () => {
    expect(snapEventFor("page_viewed", { name: "page_viewed" }).event_name).toBe("PAGE_VIEW");
    expect(snapEventFor("custom_thing", { name: "custom_thing" }).event_name).toBe("custom_thing");
  });
});

describe("redditEventFor", () => {
  test("maps to Purchase, hashes email + IP (UA raw), commerce under event_metadata", () => {
    const ev = redditEventFor("checkout_completed", checkoutEvent);
    expect(ev.event_type.tracking_type).toBe("Purchase");
    expect(ev.user.email).toBe(sha256Hex("buyer@example.com"));
    expect(ev.user.ip_address).toBe(sha256Hex("203.0.113.7")); // Reddit hashes the IP
    expect(ev.user.user_agent).toBe("Mozilla/5.0"); // UA is not hashed
    expect(ev.event_metadata.value_decimal).toBe(120);
    expect(ev.event_metadata.item_count).toBe(2);
    expect(ev.event_metadata.products[0].id).toBe("AM-9");
  });

  test("an event with no Reddit standard type is delivered as Custom with the original name", () => {
    const ev = redditEventFor("checkout_started", { name: "checkout_started" });
    expect(ev.event_type.tracking_type).toBe("Custom");
    expect(ev.event_type.custom_event_name).toBe("checkout_started");
  });
});

describe("pure helpers", () => {
  test("normalizePhoneE164 → digits with a leading +", () => {
    expect(normalizePhoneE164("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalizePhoneE164("")).toBe("");
  });

  test("checkoutHasSubscription detects a selling-plan line", () => {
    expect(checkoutHasSubscription({ data: { checkout: { lineItems: [{ sellingPlanAllocation: { sellingPlan: { id: "1" } } }] } } })).toBe(true);
    expect(checkoutHasSubscription({ data: { checkout: { lineItems: [{ quantity: 1 }] } } })).toBe(false);
    expect(checkoutHasSubscription({})).toBe(false);
  });

  test("dataLayerFromGa4 restructures GA4 params into an event + ecommerce block", () => {
    const push = dataLayerFromGa4({ name: "purchase", params: { value: 100, currency: "USD", transaction_id: "t1", items: [{ item_id: "a" }], engagement_time_msec: 1 } });
    expect(push.event).toBe("purchase");
    expect(push.ecommerce).toMatchObject({ value: 100, currency: "USD", transaction_id: "t1" });
    expect(push.engagement_time_msec).toBeUndefined(); // stripped
  });
});

describe("normalizeEmail", () => {
  test("lower-cases, strips dots in the local part and an +alias suffix (Microsoft/Bing rule)", () => {
    expect(normalizeEmail("John.Doe+promo@Gmail.com")).toBe("johndoe@gmail.com");
    expect(normalizeEmail("  Buyer@Example.com ")).toBe("buyer@example.com");
    expect(normalizeEmail("not-an-email")).toBe("");
    expect(normalizeEmail("")).toBe("");
  });
});

describe("bingEventFor", () => {
  test("maps a purchase, hashes Microsoft-normalized email + E.164 phone, carries commerce", () => {
    const ev = bingEventFor("checkout_completed", { ...checkoutEvent, msclkid: "msc_1", clientId: "c.1", consent: { marketing: true } });
    expect(ev.eventType).toBe("custom");
    expect(ev.eventName).toBe("purchase");
    expect(ev.eventId).toBe("order:5500000000001"); // order-scoped → dedups vs a client-side UET tag hit
    expect(ev.eventTime).toBe(Math.floor(Date.parse("2026-07-03T10:00:00.000Z") / 1000)); // UNIX seconds
    expect(ev.userData.em).toBe(sha256Hex("buyer@example.com"));
    expect(ev.userData.ph).toBe(sha256Hex("+14155550100")); // E.164 with the leading +
    expect(ev.userData.msclkid).toBe("msc_1");
    expect(ev.userData.anonymousId).toBe("c.1");
    expect(ev.customData.pageType).toBe("purchase");
    expect(ev.customData.value).toBe(120);
    expect(ev.customData.ecommTotalValue).toBe(120);
    expect(ev.customData.transactionId).toBe("5500000000001");
    expect(ev.customData.itemIds).toEqual(["AM-9"]);
    expect(ev.adStorageConsent).toBe("G");
  });

  test("declined marketing consent sets adStorageConsent to D", () => {
    const ev = bingEventFor("product_viewed", { name: "product_viewed", consent: { marketing: false }, data: {} });
    expect(ev.eventName).toBe("view_item");
    expect(ev.adStorageConsent).toBe("D");
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

describe("linkedinEventFor", () => {
  test("builds a conversion matched on the SHA-256 email, with ms timestamp, order-scoped id + value", () => {
    const ev = linkedinEventFor("checkout_completed", { ...checkoutEvent, liFatId: "li_fat_abc" });
    expect(ev.user.userIds).toContainEqual({ idType: "SHA256_EMAIL", idValue: sha256Hex("buyer@example.com") });
    expect(ev.user.userIds).toContainEqual({ idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: "li_fat_abc" });
    expect(ev.conversionHappenedAt).toBe(Date.parse("2026-07-03T10:00:00.000Z")); // epoch MS, not seconds
    expect(ev.eventId).toBe("order:5500000000001"); // order-scoped → dedups vs the LinkedIn Insight Tag
    expect(ev.conversionValue).toEqual({ currencyCode: "USD", amount: "120" });
  });

  test("returns null when there's no email or li_fat_id to match on", () => {
    expect(linkedinEventFor("page_viewed", { name: "page_viewed", id: "x", data: {} })).toBeNull();
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

  test("subscription GA4-purchase suppression is gated on the subscriptionTracking setting (no permanent GA4 loss)", () => {
    const ga4Base = {
      shopDomain: "s.myshopify.com",
      serverSide: true,
      ga4Id: "G-TEST",
      serverSideKeys: JSON.stringify({ ga4ApiSecret: "sec" }),
      eventMatrix: JSON.stringify({ ga4: ["checkout_completed"] }),
    };
    const subEvent = {
      ...checkoutEvent,
      data: { checkout: { ...checkoutEvent.data.checkout, lineItems: [{ ...checkoutEvent.data.checkout.lineItems[0], sellingPlanAllocation: { sellingPlan: { id: "sp1" } } }] } },
    };
    // Subscription tracking OFF: the webhook won't deliver the GA4 purchase, so the pixel MUST still send
    // it (suppressing here was the permanent-loss bug).
    expect(buildJobs(ga4Base, subEvent).some((j) => j.destination === "ga4")).toBe(true);
    // Subscription tracking ON: the webhook delivers it, so the pixel GA4 purchase is suppressed (no double).
    expect(buildJobs({ ...ga4Base, subscriptionTracking: true }, subEvent).some((j) => j.destination === "ga4")).toBe(false);
    // A non-subscription checkout always sends GA4 regardless of the setting.
    expect(buildJobs(ga4Base, checkoutEvent).some((j) => j.destination === "ga4")).toBe(true);
  });

  const linkedinBase = { shopDomain: "s.myshopify.com", serverSide: true, linkedinConversionId: "12345678", eventMatrix: JSON.stringify({ linkedin: ["checkout_completed"] }) };

  test("adds a LinkedIn job only with a conversion id + access token, and marketing-consent-gated", () => {
    const withToken = { ...linkedinBase, serverSideKeys: JSON.stringify({ linkedinAccessToken: "tok" }) };
    expect(buildJobs(withToken, checkoutEvent).some((j) => j.destination === "linkedin")).toBe(true);
    const noToken = { ...linkedinBase, serverSideKeys: JSON.stringify({}) };
    expect(buildJobs(noToken, checkoutEvent).some((j) => j.destination === "linkedin")).toBe(false);
    const declined = { ...checkoutEvent, consent: { analytics: true, marketing: false } };
    expect(buildJobs(withToken, declined).some((j) => j.destination === "linkedin")).toBe(false);
  });

  test("deliverOne posts a LinkedIn conversion to the REST endpoint with the versioned headers + urn", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201 });
    const settings = { ...linkedinBase, serverSideKeys: JSON.stringify({ linkedinAccessToken: "tok" }) };
    const [job] = buildJobs(settings, checkoutEvent).filter((j) => j.destination === "linkedin");
    const r = await deliverOne(settings, job);
    expect(r.ok).toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.linkedin.com/rest/conversionEvents");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(opts.headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
    expect(JSON.parse(opts.body).conversion).toBe("urn:lla:llaPartnerConversion:12345678");
    global.fetch = undefined;
  });

  const onsiteView = {
    name: "product_viewed",
    id: "e1",
    email: "a@b.com",
    data: { productVariant: { sku: "S", price: { amount: 5, currencyCode: "USD" }, product: { id: "p", title: "X" } } },
  };
  const klaviyoBase = { shopDomain: "s.myshopify.com", serverSide: true, eventMatrix: JSON.stringify({ klaviyo: ["product_viewed"] }) };

  test("adds a Klaviyo job for a mapped onsite event only when the private key is present", () => {
    const withKey = { ...klaviyoBase, serverSideKeys: JSON.stringify({ klaviyoApiKey: "pk_1" }) };
    expect(buildJobs(withKey, onsiteView).some((j) => j.destination === "klaviyo")).toBe(true);
    const noKey = { ...klaviyoBase, serverSideKeys: JSON.stringify({}) };
    expect(buildJobs(noKey, onsiteView).some((j) => j.destination === "klaviyo")).toBe(false);
  });

  test("Klaviyo is suppressed when marketing consent is declined (it carries raw PII)", () => {
    const withKey = { ...klaviyoBase, serverSideKeys: JSON.stringify({ klaviyoApiKey: "pk_1" }) };
    const declined = { ...onsiteView, consent: { analytics: true, marketing: false } };
    expect(buildJobs(withKey, declined).some((j) => j.destination === "klaviyo")).toBe(false);
  });

  const snapRedditBase = {
    shopDomain: "s.myshopify.com",
    serverSide: true,
    snapPixelId: "snap-1",
    redditPixelId: "a2_1",
    eventMatrix: JSON.stringify({ snapchat: ["checkout_completed"], reddit: ["checkout_completed"] }),
  };

  test("adds Snapchat/Reddit jobs only when pixel id + token are both present", () => {
    const full = { ...snapRedditBase, serverSideKeys: JSON.stringify({ snapAccessToken: "s", redditAccessToken: "r" }) };
    const dests = buildJobs(full, checkoutEvent).map((j) => j.destination);
    expect(dests).toContain("snapchat");
    expect(dests).toContain("reddit");
    const noTokens = { ...snapRedditBase, serverSideKeys: JSON.stringify({}) };
    const none = buildJobs(noTokens, checkoutEvent).map((j) => j.destination);
    expect(none).not.toContain("snapchat");
    expect(none).not.toContain("reddit");
  });

  test("marketing-consent-declined suppresses Snapchat/Reddit (they carry PII)", () => {
    const full = { ...snapRedditBase, serverSideKeys: JSON.stringify({ snapAccessToken: "s", redditAccessToken: "r" }) };
    const declined = { ...checkoutEvent, consent: { analytics: true, marketing: false } };
    const dests = buildJobs(full, declined).map((j) => j.destination);
    expect(dests).not.toContain("snapchat");
    expect(dests).not.toContain("reddit");
  });

  const bingBase = { shopDomain: "s.myshopify.com", serverSide: true, bingUetId: "1290000", eventMatrix: JSON.stringify({ bing: ["checkout_completed"] }) };

  test("adds a Bing job only with a UET tag id + CAPI token, and marketing-consent-gated", () => {
    const withToken = { ...bingBase, serverSideKeys: JSON.stringify({ bingCapiToken: "tok" }) };
    expect(buildJobs(withToken, checkoutEvent).some((j) => j.destination === "bing")).toBe(true);
    const noToken = { ...bingBase, serverSideKeys: JSON.stringify({}) };
    expect(buildJobs(noToken, checkoutEvent).some((j) => j.destination === "bing")).toBe(false);
    const declined = { ...checkoutEvent, consent: { analytics: true, marketing: false } };
    expect(buildJobs(withToken, declined).some((j) => j.destination === "bing")).toBe(false);
  });
});

describe("credential validators", () => {
  afterEach(() => (global.fetch = undefined));

  test("validateGa4Event passes when the MP debug endpoint returns no validation messages", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ validationMessages: [] }) });
    const settings = { ga4Id: "G-1", serverSideKeys: JSON.stringify({ ga4ApiSecret: "s" }) };
    const r = await validateGa4Event(settings, { name: "purchase", params: { value: 1 } });
    expect(r.ok).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toContain("/debug/mp/collect");
  });

  test("validateGa4Event surfaces the endpoint's validation messages", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ validationMessages: [{ description: "bad currency" }] }) });
    const r = await validateGa4Event({ ga4Id: "G-1", serverSideKeys: JSON.stringify({ ga4ApiSecret: "s" }) }, { name: "purchase" });
    expect(r.ok).toBe(false);
    expect(r.messages).toContain("bad currency");
  });

  test("validateGa4Event fails fast without a secret", async () => {
    expect(await validateGa4Event({ ga4Id: "G-1" }, {})).toMatchObject({ ok: false });
  });

  test("validateMetaEvent posts a test event and passes on events_received>=1", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ events_received: 1 }) });
    const settings = { metaPixelId: "PIX", serverSideKeys: JSON.stringify({ metaCapiToken: "t" }) };
    const r = await validateMetaEvent(settings, { testEventCode: "TEST123" });
    expect(r.ok).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toContain("graph.facebook.com");
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).test_event_code).toBe("TEST123");
  });

  test("validateMetaEvent reports a missing token", async () => {
    expect(await validateMetaEvent({ metaPixelId: "PIX" })).toMatchObject({ ok: false });
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

  test("klaviyo posts to the Events API with the Klaviyo-API-Key header + revision", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    const settings = { serverSideKeys: JSON.stringify({ klaviyoApiKey: "pk_1" }) };
    const r = await deliverOne(settings, { destination: "klaviyo", event: { data: { type: "event" } } });
    expect(r.ok).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toBe("https://a.klaviyo.com/api/events");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Klaviyo-API-Key pk_1");
    expect(global.fetch.mock.calls[0][1].headers.revision).toBeTruthy();
  });

  test("snapchat posts to the v3 Conversions API with the pixel id in the path + token query param", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const settings = { snapPixelId: "snap-1", serverSideKeys: JSON.stringify({ snapAccessToken: "tok" }) };
    const r = await deliverOne(settings, { destination: "snapchat", event: { event_name: "PURCHASE" } });
    expect(r.ok).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toContain("tr.snapchat.com/v3/snap-1/events");
    expect(global.fetch.mock.calls[0][0]).toContain("access_token=tok");
  });

  test("reddit posts under the pixel id with a Bearer token", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const settings = { redditPixelId: "a2_1", serverSideKeys: JSON.stringify({ redditAccessToken: "tok" }) };
    const r = await deliverOne(settings, { destination: "reddit", event: { event_type: { tracking_type: "Purchase" } } });
    expect(r.ok).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toContain("ads-api.reddit.com/api/v2.0/conversions/events/a2_1");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  test("meta 200 with an { error } body is treated as a FAILURE (so it retries, not silently lost)", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ error: { message: "Invalid access token" } }) });
    const settings = { metaPixelId: "PIX", serverSideKeys: JSON.stringify({ metaCapiToken: "bad" }) };
    const r = await deliverOne(settings, { destination: "meta", event: { event_name: "Purchase" } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Invalid access token");
  });

  test("meta 200 with events_received:0 is treated as a failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ events_received: 0 }) });
    const settings = { metaPixelId: "PIX", serverSideKeys: JSON.stringify({ metaCapiToken: "tok" }) };
    const r = await deliverOne(settings, { destination: "meta", event: { event_name: "Purchase" } });
    expect(r.ok).toBe(false);
  });

  test("meta 200 with events_received:1 stays a success", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ events_received: 1 }) });
    const settings = { metaPixelId: "PIX", serverSideKeys: JSON.stringify({ metaCapiToken: "tok" }) };
    const r = await deliverOne(settings, { destination: "meta", event: { event_name: "Purchase" } });
    expect(r.ok).toBe(true);
  });

  test("tiktok 200 with a non-zero code is treated as a failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 40000, message: "param error" }) });
    const settings = { tiktokPixelId: "C4ABC", serverSideKeys: JSON.stringify({ tiktokAccessToken: "tok" }) };
    const r = await deliverOne(settings, { destination: "tiktok", event: { event: "CompletePayment" } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("param error");
  });

  test("bing posts to the UET Conversions API under the tag id with a Bearer token", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const settings = { bingUetId: "1290000", serverSideKeys: JSON.stringify({ bingCapiToken: "tok" }) };
    const r = await deliverOne(settings, { destination: "bing", event: { eventType: "custom", eventName: "purchase" } });
    expect(r.ok).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toBe("https://capi.uet.microsoft.com/v1/1290000/events");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  test("bing 400 with an { error } body is treated as a failure (so it retries, not silently lost)", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { code: "ValidationError", message: "'em' must be a valid SHA256 string." } }) });
    const settings = { bingUetId: "1290000", serverSideKeys: JSON.stringify({ bingCapiToken: "tok" }) };
    const r = await deliverOne(settings, { destination: "bing", event: { eventType: "custom" } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("SHA256");
  });

  test("unconfigured destinations report a clean reason (no throw)", async () => {
    expect(await deliverOne({}, { destination: "tiktok", event: {} })).toMatchObject({ ok: false });
    expect(await deliverOne({}, { destination: "pinterest", event: {} })).toMatchObject({ ok: false });
    expect(await deliverOne({}, { destination: "klaviyo", event: {} })).toMatchObject({ ok: false });
    expect(await deliverOne({}, { destination: "snapchat", event: {} })).toMatchObject({ ok: false });
    expect(await deliverOne({}, { destination: "reddit", event: {} })).toMatchObject({ ok: false });
    expect(await deliverOne({}, { destination: "bing", event: {} })).toMatchObject({ ok: false });
  });
});

// GA4 joins a Measurement Protocol hit to an existing session — and so inherits that session's traffic
// source (Session source / channel group) — only with client_id + session_id + the hit's REAL time.
// Without timestamp_micros GA4 stamps at receipt time, so a late-delivered purchase (reconcile backfill,
// outbox retry) misses the session and reports as Unassigned / (not set).
describe("ga4TimestampMicros", () => {
  const NOW = Date.parse("2026-07-14T12:00:00Z");
  const isoAgo = (ms) => new Date(NOW - ms).toISOString();

  test("converts the event time to microseconds", () => {
    const t = Date.parse("2026-07-14T11:59:00Z");
    expect(ga4TimestampMicros("2026-07-14T11:59:00Z", NOW)).toBe(String(t * 1000));
  });

  test("accepts a backdated hit inside GA4's 72h window", () => {
    expect(ga4TimestampMicros(isoAgo(GA4_MAX_BACKDATE_MS - 60_000), NOW)).not.toBeNull();
  });

  test("omits the timestamp beyond 72h — GA4 would DROP the event, and a landed-but-unattributed conversion beats a lost one", () => {
    expect(ga4TimestampMicros(isoAgo(GA4_MAX_BACKDATE_MS + 60_000), NOW)).toBeNull();
  });

  test("omits a future timestamp (clock skew) and lets GA4 stamp it", () => {
    expect(ga4TimestampMicros(new Date(NOW + 10 * 60_000).toISOString(), NOW)).toBeNull();
  });

  test("missing / unparseable timestamp → null", () => {
    expect(ga4TimestampMicros(undefined, NOW)).toBeNull();
    expect(ga4TimestampMicros("not-a-date", NOW)).toBeNull();
  });
});
