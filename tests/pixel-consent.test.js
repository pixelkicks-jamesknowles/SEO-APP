/* eslint-disable import/first -- jest.mock() must precede the imports it intercepts */
// Captures the callback the extension passes to register(), so we can drive the pixel with a fake
// Shopify runtime and assert what it beacons.
let registered = null;
jest.mock("@shopify/web-pixels-extension", () => ({ register: (fn) => (registered = fn) }), { virtual: true });

const CONFIG = {
  ga4Id: "G-ABC123",
  eventMatrix: { ga4: ["page_viewed", "checkout_completed"] },
  consentMode: true,
  consentSignals: true,
  trackUrl: "https://tracking.example.com/pixel/track",
  shopDomain: "s.myshopify.com",
  trackToken: "tok",
};

const DENIED = { analyticsProcessingAllowed: false, marketingAllowed: false };
const GRANTED = { analyticsProcessingAllowed: true, marketingAllowed: true };

/** Boot the pixel with a fake runtime. Returns handles to drive it and read what it sent. */
async function boot({ initialConsent }) {
  jest.resetModules();
  registered = null;
  const handlers = {};
  let consentCallback = null;
  const sent = [];

  global.fetch = jest.fn(async () => ({ ok: true }));

  await import("../extensions/tracking-pixel/src/index.js");

  registered({
    analytics: { subscribe: (name, cb) => (handlers[name] = cb) },
    browser: {
      cookie: { get: async (name) => (name === "_ga" ? "GA1.1.1234567890.1700000000" : null) },
      sendBeacon: async (url, body) => {
        sent.push(JSON.parse(body));
        return true;
      },
    },
    settings: { config: JSON.stringify(CONFIG) },
    init: { customerPrivacy: initialConsent, context: {}, data: {} },
    customerPrivacy: { subscribe: (name, cb) => (name === "visitorConsentCollected" ? (consentCallback = cb) : null) },
  });

  return {
    sent,
    fire: async (name) => {
      // The extension's subscribe callback fires route() without returning its promise, so awaiting the
      // callback is not enough — flush the microtask queue to let the async cookie reads + beacon land.
      handlers[name]?.({ id: `evt_${name}`, timestamp: "2026-09-14T10:00:00Z", name, data: {}, context: {} });
      await new Promise((r) => setTimeout(r, 0));
    },
    setConsent: (privacy) => consentCallback?.({ customerPrivacy: privacy }),
  };
}

describe("Web Pixel consent is read live, not from the init snapshot", () => {
  test("consent granted at load: identifiers are attached", async () => {
    const pixel = await boot({ initialConsent: GRANTED });
    await pixel.fire("checkout_completed");
    expect(pixel.sent).toHaveLength(1);
    expect(pixel.sent[0].event.clientId).toBe("1234567890.1700000000");
  });

  test("consent denied at load: the flagged hit carries NO client id", async () => {
    // Consent Mode v2 still sends so GA4 can model the gap, but deliberately without identifiers.
    const pixel = await boot({ initialConsent: DENIED });
    await pixel.fire("checkout_completed");
    expect(pixel.sent).toHaveLength(1);
    expect(pixel.sent[0].event.clientId).toBeUndefined();
  });

  test("THE BUG: consent accepted AFTER load must be honoured on later events", async () => {
    // The pixel loads before the shopper answers the cookie banner, so init says denied. Previously the
    // pixel re-read that frozen snapshot on every event and never attached a client id again — so the
    // checkout, which happens long after consent was given, arrived anonymous and could never be
    // stitched to the visitor. "Identified" was pinned at 0 as a direct result.
    const pixel = await boot({ initialConsent: DENIED });

    await pixel.fire("page_viewed"); // before the banner is answered
    expect(pixel.sent[0].event.clientId).toBeUndefined();

    pixel.setConsent(GRANTED); // shopper accepts

    await pixel.fire("checkout_completed");
    expect(pixel.sent).toHaveLength(2);
    expect(pixel.sent[1].event.clientId).toBe("1234567890.1700000000");
  });

  test("a consent WITHDRAWAL is honoured too — the state tracks both directions", async () => {
    const pixel = await boot({ initialConsent: GRANTED });
    await pixel.fire("page_viewed");
    expect(pixel.sent[0].event.clientId).toBeTruthy();

    pixel.setConsent(DENIED); // shopper withdraws

    await pixel.fire("checkout_completed");
    expect(pixel.sent[1].event.clientId).toBeUndefined();
  });

  test("the pixel still boots when the consent API is absent", async () => {
    jest.resetModules();
    registered = null;
    global.fetch = jest.fn();
    await import("../extensions/tracking-pixel/src/index.js");
    expect(() =>
      registered({
        analytics: { subscribe: () => {} },
        browser: { cookie: { get: async () => null }, sendBeacon: async () => true },
        settings: { config: JSON.stringify(CONFIG) },
        init: {},
        // No customerPrivacy at all — an older runtime, or a context that doesn't provide it.
      }),
    ).not.toThrow();
  });
});
