import { consentState, orderConsentState } from "../app/lib/consent.js";

describe("consentState", () => {
  test("an explicit signal is reported as given", () => {
    expect(consentState({ analytics: true })).toBe("granted");
    expect(consentState({ analytics: false })).toBe("denied");
    expect(consentState({ analytics: false, marketing: true })).toBe("denied");
  });

  test("NO signal is 'unknown', never folded into granted", () => {
    // This is the whole point: a store with Consent mode off sends no consent object, and counting those
    // as granted is what made the Accuracy consent rate read 100% with zero denials.
    expect(consentState(undefined)).toBe("unknown");
    expect(consentState(null)).toBe("unknown");
    expect(consentState({})).toBe("unknown"); // object present, analytics not specified
    expect(consentState({ marketing: false })).toBe("unknown"); // marketing denied says nothing about analytics
  });
});

describe("orderConsentState — the order-level signal", () => {
  const order = (value) => ({ note_attributes: value === undefined ? [] : [{ name: "pxp_analytics_consent", value }] });

  test("reads what the theme embed captured", () => {
    expect(orderConsentState(order("granted"))).toBe("granted");
    expect(orderConsentState(order("denied"))).toBe("denied");
    expect(orderConsentState(order("GRANTED"))).toBe("granted"); // case-insensitive
  });

  test("no attribute is 'unknown' — the embed never ran, which is not the same as acceptance", () => {
    expect(orderConsentState(order())).toBe("unknown");
    expect(orderConsentState(order(""))).toBe("unknown");
    expect(orderConsentState({})).toBe("unknown");
    expect(orderConsentState(null)).toBe("unknown");
  });

  test("marketing consent is NOT used as a stand-in for analytics consent", () => {
    // buyer_accepts_marketing answers a different question; reading it here would be wrong.
    expect(orderConsentState({ buyer_accepts_marketing: true, note_attributes: [] })).toBe("unknown");
  });
});
