import { classifyOrderType, hasClientId, hasSessionId, consentSignal, embedVersion, foldConsentAudit, summarizeConsentAudit } from "../app/lib/consent-audit.js";

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

// The session id is the number that actually decides attribution. A client id proves consent was granted;
// GA4 still needs client_id AND session_id to join the purchase to a session that has a traffic source.
describe("hasSessionId / consentSignal", () => {
  const withBoth = { customAttributes: [{ key: "ga_client_id", value: "1.2" }, { key: "ga_session_id", value: "999" }] };
  const idOnly = { customAttributes: [{ key: "ga_client_id", value: "1.2" }] };

  test("session id is read independently of the client id", () => {
    expect(hasSessionId(withBoth)).toBe(true);
    expect(hasSessionId(idOnly)).toBe(false);
    expect(hasClientId(idOnly)).toBe(true); // the case that looks like "consent is fine but all Unassigned"
  });

  test("consentSignal only accepts the two real values", () => {
    expect(consentSignal({ customAttributes: [{ key: "pxp_analytics_consent", value: "granted" }] })).toBe("granted");
    expect(consentSignal({ customAttributes: [{ key: "pxp_analytics_consent", value: "DENIED" }] })).toBe("denied");
    expect(consentSignal({ customAttributes: [{ key: "pxp_analytics_consent", value: "maybe" }] })).toBeNull();
    expect(consentSignal(idOnly)).toBeNull();
  });
});

describe("summarizeConsentAudit — the attribution diagnosis", () => {
  const order = (attrs) => ({ tags: ["One-Time"], customAttributes: attrs, lineItems: { nodes: [{ sellingPlan: null }] } });
  const cid = { key: "ga_client_id", value: "1.2" };
  const sid = { key: "ga_session_id", value: "999" };

  test("client id high but session id low is reported as its own gap", () => {
    // This is the shape that means consent is NOT the problem: shoppers consented, the id landed, but the
    // embed could not find the `_ga_<CONTAINER>` cookie, so GA4 has no session to attribute against.
    const tally = foldConsentAudit([order([cid]), order([cid]), order([cid]), order([cid, sid])], {});
    const s = summarizeConsentAudit(tally);
    expect(s.excludingRenewals.floorPct).toBe(100);
    expect(s.excludingRenewals.sessionPct).toBe(25);
  });

  test("the explicit consent attribute is counted across every order type", () => {
    // It answers "is the current embed live at all", so a renewal carrying one still counts.
    const tally = foldConsentAudit(
      [order([{ key: "pxp_analytics_consent", value: "granted" }]), order([{ key: "pxp_analytics_consent", value: "denied" }]), order([cid])],
      {},
    );
    expect(summarizeConsentAudit(tally).consentSignal).toEqual({ granted: 1, denied: 1, total: 2 });
  });

  test("no consent attribute anywhere reports zero, which is the 'extension never shipped' signal", () => {
    expect(summarizeConsentAudit(foldConsentAudit([order([cid, sid])], {})).consentSignal.total).toBe(0);
  });
});

// The build marker exists to separate two causes that were otherwise indistinguishable: a release that was
// created but never made live, versus one that shipped fine but has had no orders yet. Both show zero
// consent attributes.
describe("embedVersion", () => {
  const order = (attrs) => ({ tags: ["One-Time"], customAttributes: attrs, lineItems: { nodes: [{ sellingPlan: null }] } });

  test("counts orders written by an embed carrying the marker", () => {
    const tally = foldConsentAudit(
      [order([{ key: "pxp_embed", value: "2" }]), order([{ key: "pxp_embed", value: "2" }]), order([{ key: "ga_client_id", value: "1.2" }])],
      {},
    );
    expect(summarizeConsentAudit(tally).newEmbedOrders).toBe(2);
  });

  test("zero marked orders is the 'release never went live' signal", () => {
    const tally = foldConsentAudit([order([{ key: "ga_client_id", value: "1.2" }])], {});
    const s = summarizeConsentAudit(tally);
    expect(s.newEmbedOrders).toBe(0);
    expect(s.consentSignal.total).toBe(0); // both zero — the ambiguous case the marker resolves
  });

  test("marked but no consent attribute means the release IS live and something else is wrong", () => {
    const tally = foldConsentAudit([order([{ key: "pxp_embed", value: "2" }])], {});
    const s = summarizeConsentAudit(tally);
    expect(s.newEmbedOrders).toBe(1);
    expect(s.consentSignal.total).toBe(0);
  });
});
