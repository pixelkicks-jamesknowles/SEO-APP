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
// a denied count. Every label says "floor" for that reason — reading "no id" as "opted out" would invent
// a number.
//
// WHY IT ALSO COUNTS session id AND the consent attribute. Three different questions, one scan:
//   ga_client_id           → was consent granted? (the floor above)
//   ga_session_id          → can GA4 actually ATTRIBUTE the purchase? A client id alone is not enough; GA4
//                            needs client_id + session_id to join the hit to a session that has a traffic
//                            source. The embed writes the session id only when it can read a
//                            `_ga_<CONTAINER>` cookie, and that suffix comes from the Measurement ID
//                            configured on the Tracking page. A different on-page property means that
//                            cookie never exists, so client id lands and session id does not — which looks
//                            exactly like "consent is fine but everything is Unassigned".
//   pxp_analytics_consent  → is the CURRENT embed actually live? It has only been written since
//                            2026-09-16, so a count of zero on recent orders means the extension deploy
//                            never reached storefronts.

/** Recharge's own markers, matching rechargeOrderType() in subscription.js. Keep the two in step or this
 *  audit's split will disagree with how the app classifies the same orders. */
const RECURRING = /\brecurring_subscription\b|subscription recurring order|autorenew/;
const FIRST_SUB = /\bcheckout_subscription\b|subscription first order/;

const attrValue = (node, key) => (node?.customAttributes || []).find((a) => a?.key === key)?.value || null;

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
  return !!attrValue(node, "ga_client_id");
}

/** True when the order carries a non-empty ga_session_id. Without this GA4 cannot join the purchase to a
 *  session, so it opens a fresh source-less one and the sale reports as Unassigned. Pure. */
export function hasSessionId(node) {
  return !!attrValue(node, "ga_session_id");
}

/** The embed build that wrote this order's cart attributes, or null for an order written by a build older
 *  than the marker. Turns "did the release actually go live?" into something order data answers: the
 *  absence of pxp_analytics_consent alone cannot distinguish a stalled release from no orders yet. Pure. */
export function embedVersion(node) {
  return attrValue(node, "pxp_embed") || null;
}

/** "granted" | "denied" | null — the explicit consent attribute the CURRENT embed writes. null means the
 *  attribute is absent entirely, which for a recent order means the new embed is not live. Pure. */
export function consentSignal(node) {
  const v = String(attrValue(node, "pxp_analytics_consent") || "").toLowerCase();
  return v === "granted" || v === "denied" ? v : null;
}

const emptyBucket = () => ({ total: 0, withId: 0, withSession: 0, consentGranted: 0, consentDenied: 0, newEmbed: 0 });

/** Fold a page of order nodes into a { type -> bucket } tally. Mutates and returns `tally` so it can
 *  accumulate across pages. Pure apart from that. */
export function foldConsentAudit(nodes, tally = {}) {
  for (const node of nodes || []) {
    const kind = classifyOrderType(node);
    const t = tally[kind] || emptyBucket();
    t.total += 1;
    if (hasClientId(node)) t.withId += 1;
    if (hasSessionId(node)) t.withSession += 1;
    const signal = consentSignal(node);
    if (signal === "granted") t.consentGranted += 1;
    if (signal === "denied") t.consentDenied += 1;
    if (embedVersion(node)) t.newEmbed += 1;
    tally[kind] = t;
  }
  return tally;
}

/**
 * Turn a tally into the reportable shape.
 *
 * Renewals are reported but EXCLUDED from the headline figures: a recurring order never has a browser
 * session, so it cannot carry any of these attributes and its absence says nothing. Counting them would
 * depress every rate for a reason unrelated to the question. Pure.
 */
export function summarizeConsentAudit(tally = {}) {
  const pct = (n, d) => (d ? (n / d) * 100 : 0);
  const rows = Object.entries(tally)
    .map(([type, t]) => ({
      type,
      total: t.total,
      withId: t.withId,
      withSession: t.withSession,
      pct: pct(t.withId, t.total),
      sessionPct: pct(t.withSession, t.total),
    }))
    .sort((a, b) => b.total - a.total);

  const live = Object.entries(tally)
    .filter(([type]) => type !== "renewal")
    .reduce(
      (a, [, t]) => ({
        total: a.total + t.total,
        withId: a.withId + t.withId,
        withSession: a.withSession + t.withSession,
      }),
      { total: 0, withId: 0, withSession: 0 },
    );

  // The explicit attribute is counted across EVERY order type. The question it answers is "is the current
  // embed live at all", and a single one anywhere proves it is.
  const consent = Object.values(tally).reduce(
    (a, t) => ({ granted: a.granted + t.consentGranted, denied: a.denied + t.consentDenied }),
    { granted: 0, denied: 0 },
  );
  // How many orders were written by an embed carrying the build marker. Zero across recent orders is
  // positive evidence the release never reached storefronts, rather than an ambiguous absence.
  const newEmbedOrders = Object.values(tally).reduce((n, t) => n + t.newEmbed, 0);

  return {
    rows,
    excludingRenewals: {
      ...live,
      floorPct: pct(live.withId, live.total),
      sessionPct: pct(live.withSession, live.total),
    },
    consentSignal: { ...consent, total: consent.granted + consent.denied },
    newEmbedOrders,
    scanned: rows.reduce((n, r) => n + r.total, 0),
  };
}
