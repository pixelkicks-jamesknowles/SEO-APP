import { analyticsConsented } from "../app/lib/consent.js";

describe("analyticsConsented", () => {
  test("explicit analytics:false is the only 'denied' case", () => {
    expect(analyticsConsented({ analytics: false })).toBe(false);
    expect(analyticsConsented({ analytics: false, marketing: true })).toBe(false);
  });
  test("granted / unknown consent counts as granted (matches the GA4 delivery convention)", () => {
    expect(analyticsConsented({ analytics: true })).toBe(true);
    expect(analyticsConsented(undefined)).toBe(true);
    expect(analyticsConsented(null)).toBe(true);
    expect(analyticsConsented({})).toBe(true); // analytics not specified → granted
    expect(analyticsConsented({ marketing: false })).toBe(true); // marketing denied, analytics unknown → granted
  });
});
