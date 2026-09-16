import { classifyOrderType, hasClientId, foldConsentAudit, summarizeConsentAudit } from "../app/lib/consent-audit.js";

// Shapes taken from REAL Naturaw orders pulled 2026-09-14, so the classification is pinned against what
// the store actually sends rather than what we imagine it sends.
const renewal = {
  tags: ["Bundle", "Ready to Ship", "Recharge", "Subscription", "Subscription Recurring Order"],
  customAttributes: [{ key: "_metorik_referer", value: "https://www.google.com/" }],
  lineItems: { nodes: [{ sellingPlan: { name: "8 week subscription with 5% discount" } }] },
};
const firstSub = {
  tags: ["Bundle", "Subscription", "Subscription Checkout", "Subscription First Order"],
  customAttributes: [{ key: "ga_client_id", value: "962702743.1789387086" }],
  lineItems: { nodes: [{ sellingPlan: { name: "4 week subscription" } }, { sellingPlan: null }] },
};
const oneOffWithId = {
  tags: ["One-Time"],
  customAttributes: [{ key: "ga_client_id", value: "1701947277.1789387185" }],
  lineItems: { nodes: [{ sellingPlan: null }] },
};
const oneOffNoId = { tags: ["One-Time"], customAttributes: [], lineItems: { nodes: [{ sellingPlan: null }] } };
// A selling plan but only a bare "Recharge" tag — neither Recharge lifecycle marker is present.
const untagged = {
  tags: ["Bundle", "Recharge"],
  customAttributes: [],
  lineItems: { nodes: [{ sellingPlan: { name: "7 week subscription" } }] },
};

describe("classifyOrderType", () => {
  test("reads Recharge's lifecycle tags", () => {
    expect(classifyOrderType(renewal)).toBe("renewal");
    expect(classifyOrderType(firstSub)).toBe("subscription_checkout");
  });

  test("a selling plan with no lifecycle tag is its own bucket, not folded into either", () => {
    // Folding it into renewal would overstate renewals; into subscription_checkout would invent new
    // subscribers. Neither is knowable from the order alone, so it stays visible as unknown.
    expect(classifyOrderType(untagged)).toBe("subscription (untagged)");
  });

  test("everything else is a one-off", () => {
    expect(classifyOrderType(oneOffNoId)).toBe("one_off");
    expect(classifyOrderType({})).toBe("one_off");
  });
});

describe("hasClientId", () => {
  test("requires a non-empty value, not just the key", () => {
    expect(hasClientId(oneOffWithId)).toBe(true);
    expect(hasClientId(oneOffNoId)).toBe(false);
    expect(hasClientId({ customAttributes: [{ key: "ga_client_id", value: "" }] })).toBe(false);
  });
});

describe("summarizeConsentAudit", () => {
  test("renewals are counted but EXCLUDED from the headline floor", () => {
    // A renewal has no browser session, so it can never carry a client id. Including it would drag the
    // rate down for a reason that has nothing to do with consent — the number would answer a different
    // question than the one being asked.
    const tally = foldConsentAudit([renewal, firstSub, oneOffWithId, oneOffNoId], {});
    const s = summarizeConsentAudit(tally);

    expect(s.scanned).toBe(4);
    expect(s.rows.find((r) => r.type === "renewal").total).toBe(1); // still reported
    expect(s.excludingRenewals.total).toBe(3); // but not in the denominator
    expect(s.excludingRenewals.withId).toBe(2);
    expect(s.excludingRenewals.floorPct).toBeCloseTo(66.67, 1);
  });

  test("accumulates across pages", () => {
    const tally = {};
    foldConsentAudit([oneOffWithId, oneOffNoId], tally);
    foldConsentAudit([oneOffWithId], tally);
    expect(summarizeConsentAudit(tally).excludingRenewals).toMatchObject({ total: 3, withId: 2 });
  });

  test("an empty scan reports zeroes rather than dividing by zero", () => {
    expect(summarizeConsentAudit({})).toMatchObject({ scanned: 0, excludingRenewals: { total: 0, floorPct: 0 } });
  });

  test("rows are ordered by volume so the dominant order type reads first", () => {
    const tally = foldConsentAudit([renewal, renewal, renewal, oneOffNoId], {});
    expect(summarizeConsentAudit(tally).rows[0].type).toBe("renewal");
  });
});
