import { crossRate, normalizeParams } from "../app/lib/currency.js";

// USD-based rates (units per 1 USD).
const RATES = { USD: 1, EUR: 0.5, GBP: 0.8 };

describe("crossRate", () => {
  test("identity when from === to", () => {
    expect(crossRate(RATES, "USD", "USD")).toBe(1);
  });
  test("computes a cross rate via USD", () => {
    // 1 EUR = (USD-per-EUR) → convert EUR→GBP: rt/rf = 0.8/0.5 = 1.6
    expect(crossRate(RATES, "EUR", "GBP")).toBeCloseTo(1.6);
  });
  test("null for an unknown currency (caller skips conversion)", () => {
    expect(crossRate(RATES, "EUR", "JPY")).toBeNull();
    expect(crossRate(RATES, "XXX", "USD")).toBeNull();
  });
});

describe("normalizeParams", () => {
  test("converts GA4 value + items and preserves the original", () => {
    const params = { currency: "EUR", value: 10, items: [{ price: 5 }, { price: 2.5 }] };
    normalizeParams(params, { rates: RATES, to: "GBP" }); // rate 1.6
    expect(params.currency).toBe("GBP");
    expect(params.value).toBe(16);
    expect(params.original_currency).toBe("EUR");
    expect(params.original_value).toBe(10);
    expect(params.items.map((i) => i.price)).toEqual([8, 4]);
  });

  test("converts Meta custom_data value + contents + revenue", () => {
    const cd = { currency: "EUR", value: 10, revenue: 10, contents: [{ item_price: 5 }] };
    normalizeParams(cd, { rates: RATES, to: "USD" }); // EUR→USD rate = 1/0.5 = 2
    expect(cd.value).toBe(20);
    expect(cd.revenue).toBe(20);
    expect(cd.contents[0].item_price).toBe(10);
    expect(cd.currency).toBe("USD");
  });

  test("no-op when currency already matches, missing, or unknown", () => {
    const same = { currency: "USD", value: 10 };
    expect(normalizeParams(same, { rates: RATES, to: "USD" })).toEqual({ currency: "USD", value: 10 });

    const noCur = { value: 10 };
    normalizeParams(noCur, { rates: RATES, to: "USD" });
    expect(noCur).toEqual({ value: 10 });

    const unknown = { currency: "JPY", value: 10 };
    normalizeParams(unknown, { rates: RATES, to: "USD" });
    expect(unknown).toEqual({ currency: "JPY", value: 10 }); // untouched
  });
});
