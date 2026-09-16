// Historical analytics-consent evidence, inferred from order data. Pure — unit-tested, no IO.
//
// WHY AN INFERENCE AT ALL. True consent state for orders before 2026-09-16 is gone: the embed's
// `pxp_analytics_consent` attribute was dead code (a duplicate `syncCartIds` shadowed it), so it was never
// written. But the version that DID run wrote the `ga_client_id` cart attribute only after passing
// `if (!analyticsAllowed()) return;`, so its presence is hard evidence that analytics consent was granted
// at that moment.
//
// THE INFERENCE RUNS ONE WAY. A MISSING id is ambiguous: consent denied, the embed never ran, an ad
// blocker, or gtag simply had not written `_ga` yet. So this yields a FLOOR on the granted rate and never
// a denied count. Every label here says "floor" for that reason — reading "no id" as "opted out" would
// invent a number.

/** Recharge's own markers, matching rechargeOrderType() in subscription.js. Keep the two in step or this
 *  audit's split will disagree with how the app classifies the same orders. */
const RECURRING = /\brecurring_subscription\b|subscription recurring order|autorenew/;
const FIRST_SUB = /\bcheckout_subscription\b|subscription first order/;

/** Order type from a Shopify GraphQL order node (tags array + lineItems.nodes[].sellingPlan). Pure. */
export function classifyOrderType(node) {
  const tags = (Array.isArray(node?.tags) ? node.tags.join(",") : node?.tags || "").toLowerCase();
  if (RECURRING.test(tags)) return "renewal";
  if (FIRST_SUB.test(tags)) return "subscription_checkout";
  // A selling plan with no Recharge tag: a subscription order we can't place in the lifecycle from tags
  // alone. Kept as its own bucket rather than folded into either, so it can't quietly flatter the split.
  if ((node?.lineItems?.nodes || []).some((l) => l?.sellingPlan)) return "subscription (untagged)";
  return "one_off";
}

/** True when the order carries a non-empty ga_client_id cart attribute. Pure. */
export function hasClientId(node) {
  return (node?.customAttributes || []).some((a) => a?.key === "ga_client_id" && a?.value);
}

/** Fold a page of order nodes into a { type -> { total, withId } } tally. Mutates and returns `tally` so
 *  it can accumulate across pages. Pure apart from that. */
export function foldConsentAudit(nodes, tally = {}) {
  for (const node of nodes || []) {
    const kind = classifyOrderType(node);
    const t = tally[kind] || { total: 0, withId: 0 };
    t.total += 1;
    if (hasClientId(node)) t.withId += 1;
    tally[kind] = t;
  }
  return tally;
}

/**
 * Turn a tally into the reportable shape.
 *
 * Renewals are reported but EXCLUDED from the headline floor: a recurring order never has a browser
 * session, so it cannot carry the attribute and its absence says nothing about consent. Counting them
 * would depress the rate for a reason unrelated to the question. Pure.
 */
export function summarizeConsentAudit(tally = {}) {
  const rows = Object.entries(tally)
    .map(([type, t]) => ({ type, total: t.total, withId: t.withId, pct: t.total ? (t.withId / t.total) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);
  const live = rows
    .filter((r) => r.type !== "renewal")
    .reduce((a, r) => ({ total: a.total + r.total, withId: a.withId + r.withId }), { total: 0, withId: 0 });
  return {
    rows,
    excludingRenewals: { ...live, floorPct: live.total ? (live.withId / live.total) * 100 : 0 },
    scanned: rows.reduce((n, r) => n + r.total, 0),
  };
}
