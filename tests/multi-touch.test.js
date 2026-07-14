import { creditWeights, creditByModel, MODELS } from "../app/lib/multi-touch.js";

const touch = (source, ts) => ({ source, medium: "referral", ts });
// A 3-touch path: google (day 0), facebook (day 5), klaviyo/email (day 9), converts day 10.
const path3 = [touch("google", "2026-07-01"), touch("facebook", "2026-07-06"), { source: "klaviyo", medium: "email", ts: "2026-07-10" }];

describe("creditWeights", () => {
  test("first / last / linear", () => {
    expect(creditWeights(path3, "first_touch")).toEqual([1, 0, 0]);
    expect(creditWeights(path3, "last_touch")).toEqual([0, 0, 1]);
    expect(creditWeights(path3, "linear")).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  test("position-based is 40/20/40 and sums to 1", () => {
    const w = creditWeights(path3, "position_based");
    expect(w).toEqual([0.4, 0.2, 0.4]);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  test("position-based with 2 touches → 50/50", () => {
    expect(creditWeights([touch("a", "2026-07-01"), touch("b", "2026-07-02")], "position_based")).toEqual([0.5, 0.5]);
  });

  test("single-touch path → all weight on it, any model", () => {
    for (const m of MODELS) expect(creditWeights([touch("a", "2026-07-01")], m)).toEqual([1]);
  });

  test("time decay favours recent touches and sums to 1", () => {
    const w = creditWeights(path3, "time_decay", { conversionTs: "2026-07-10", halfLifeDays: 5 });
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(w[2]).toBeGreaterThan(w[0]); // the day-10 touch outweighs the day-0 touch
  });

  test("empty path → no weights", () => {
    expect(creditWeights([], "linear")).toEqual([]);
  });
});

describe("creditByModel", () => {
  const paths = [
    { value: 100, conversionTs: "2026-07-10", touches: path3 },
    { value: 60, conversionTs: "2026-07-10", touches: [touch("google", "2026-07-02")] }, // single-touch
  ];

  test("last touch credits the final touch of each path", () => {
    const { rows, total } = creditByModel(paths, "last_touch");
    expect(total).toBe(160);
    // path1 last = klaviyo (100), path2 = google (60)
    expect(rows.find((r) => r.source === "klaviyo").credit).toBe(100);
    expect(rows.find((r) => r.source === "google").credit).toBe(60);
  });

  test("linear splits path1's 100 across its 3 touches; google also gets path2's 60", () => {
    const { rows } = creditByModel(paths, "linear");
    // google: 100/3 + 60 = 93.33
    expect(rows.find((r) => r.source === "google").credit).toBeCloseTo(93.33, 1);
    expect(rows.find((r) => r.source === "facebook").credit).toBeCloseTo(33.33, 1);
  });

  test("credited conversions sum to the number of paths", () => {
    const { rows } = creditByModel(paths, "position_based");
    const conv = rows.reduce((t, r) => t + r.conversions, 0);
    expect(conv).toBeCloseTo(2);
  });

  test("empty → zero", () => {
    expect(creditByModel([], "linear")).toEqual({ total: 0, rows: [] });
  });
});
