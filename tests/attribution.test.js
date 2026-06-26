import { parseUtms, customerKey } from "../app/lib/attribution.js";
import { buildSubscriptionEvent } from "../app/lib/subscription.js";

describe("parseUtms", () => {
  test("reads UTMs from the landing_site query string", () => {
    const utms = parseUtms({ landing_site: "/products/x?utm_source=google&utm_medium=cpc&utm_campaign=spring" });
    expect(utms).toEqual({ source: "google", medium: "cpc", campaign: "spring" });
  });

  test("falls back to note_attributes when landing_site has none", () => {
    const utms = parseUtms({
      landing_site: "/",
      note_attributes: [{ name: "utm_source", value: "klaviyo" }, { name: "utm_medium", value: "email" }],
    });
    expect(utms.source).toBe("klaviyo");
    expect(utms.medium).toBe("email");
    expect(utms.campaign).toBeNull();
  });

  test("returns nulls when nothing is present", () => {
    expect(parseUtms({})).toEqual({ source: null, medium: null, campaign: null });
  });
});

describe("customerKey", () => {
  test("prefers the customer id", () => {
    expect(customerKey({ customer: { id: 42 }, email: "a@b.com" })).toBe("42");
  });
  test("falls back to a normalized email", () => {
    expect(customerKey({ email: " A@B.com " })).toBe("e:a@b.com");
  });
  test("is null with neither", () => {
    expect(customerKey({})).toBeNull();
  });
});

describe("buildSubscriptionEvent attribution", () => {
  test("stamps recurring orders with the first order's source/medium/campaign", () => {
    const ev = buildSubscriptionEvent(
      { id: 7, currency: "GBP", line_items: [] },
      { attribution: { source: "google", medium: "cpc", campaign: "spring" }, clientId: "111.222" },
    );
    expect(ev.params.source).toBe("google");
    expect(ev.params.medium).toBe("cpc");
    expect(ev.params.campaign).toBe("spring");
    expect(ev.clientId).toBe("111.222");
  });
});
