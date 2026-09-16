// One-off read-only audit: how many past orders show evidence that analytics consent was GRANTED?
//
// WHY THIS CAN ANSWER ANYTHING AT ALL
// The embed that ran until 2026-09-16 wrote the `ga_client_id` cart attribute only after passing
// `if (!analyticsAllowed()) return;`. So its presence on a historical order is hard evidence that analytics
// consent was granted at that moment. That is the only consent signal those orders carry — the
// `pxp_analytics_consent` attribute was dead code (a duplicate syncCartIds shadowed it), so true consent
// state for them is gone for good.
//
// WHAT IT CANNOT TELL YOU
// The inference runs ONE WAY. A missing ga_client_id is ambiguous: consent denied, the embed never ran, an
// ad blocker, or gtag simply had not written `_ga` yet. So this reports a FLOOR on the granted rate and
// never a denied count. Do not read "no id" as "opted out".
//
// Renewals are reported separately and excluded from the headline rate. A recurring subscription order has
// no browser session at all, so it can never carry the attribute and would drag the number down for a
// reason that has nothing to do with consent.
//
// WHAT IT IS FOR
// Testing whether consent explains a high "Unassigned" share in GA4. If the granted floor is far above the
// share of purchases GA4 gave a channel to, consent is NOT the whole story and the next suspect is a GA4
// measurement-ID mismatch (the pixel reads `_ga_<id>` for the id configured on the Tracking page; if the
// on-page tag uses a different property that cookie never exists).
//
// Writes nothing. Reads orders only.
//
// Env:
//   SHOP          (required)  e.g. naturaw.myshopify.com
//   ADMIN_TOKEN   (required)  Admin API access token with read_orders (+ read_all_orders beyond 60 days)
//   DAYS          (optional)  look-back window, default 28 to match a GA4 "Last 28 days" report
//   API_VERSION   (optional)  default 2026-04, matching shopify.app.toml

const SHOP = process.env.SHOP;
const TOKEN = process.env.ADMIN_TOKEN;
const DAYS = Number(process.env.DAYS || 28);
const API_VERSION = process.env.API_VERSION || "2026-04";

if (!SHOP || !TOKEN) {
  console.error("consent-audit: set SHOP and ADMIN_TOKEN");
  console.error("  SHOP=naturaw.myshopify.com ADMIN_TOKEN=shpat_... node scripts/consent-audit.mjs");
  process.exit(1);
}

const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

// Mirrors the detection the app itself uses (subscription.js): a Shopify selling plan on any line, else
// Recharge's tags. Keep these in step with rechargeOrderType() or the split here will disagree with the app.
const RECURRING = /\brecurring_subscription\b|subscription recurring order|autorenew/;
const FIRST_SUB = /\bcheckout_subscription\b|subscription first order/;

const QUERY = `
  query ConsentAudit($cursor: String, $query: String) {
    orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        createdAt
        tags
        customAttributes { key value }
        lineItems(first: 10) { nodes { sellingPlan { name } } }
      }
    }
  }`;

async function page(cursor) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query: QUERY, variables: { cursor, query: `created_at:>=${since} financial_status:paid` } }),
  });
  const body = await res.json();
  if (!body?.data?.orders) throw new Error(body?.errors?.[0]?.message || `HTTP ${res.status}`);
  return body.data.orders;
}

function classify(node) {
  const tags = (node.tags || []).join(",").toLowerCase();
  const hasPlan = (node.lineItems?.nodes || []).some((l) => l?.sellingPlan);
  if (RECURRING.test(tags)) return "renewal";
  if (FIRST_SUB.test(tags)) return "subscription_checkout";
  if (hasPlan) return "subscription (untagged)";
  return "one_off";
}

const tally = new Map();
const bump = (kind, withId) => {
  const t = tally.get(kind) || { total: 0, withId: 0 };
  t.total++;
  if (withId) t.withId++;
  tally.set(kind, t);
};

let cursor = null;
let scanned = 0;
try {
  for (;;) {
    const conn = await page(cursor);
    for (const n of conn.nodes || []) {
      const attrs = n.customAttributes || [];
      bump(classify(n), attrs.some((a) => a.key === "ga_client_id" && a.value));
      scanned++;
    }
    process.stderr.write(`\rscanned ${scanned}…`);
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
} catch (e) {
  console.error(`\nconsent-audit: ${e.message}`);
  process.exit(1);
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
console.error(`\r${" ".repeat(24)}\r`);
console.log(`Consent audit — ${SHOP}, orders since ${since} (${scanned} paid orders)\n`);
console.log("order type                 orders   with ga_client_id   granted (floor)");
for (const [kind, t] of [...tally].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${kind.padEnd(24)} ${String(t.total).padStart(7)} ${String(t.withId).padStart(19)} ${pct(t.withId, t.total).padStart(17)}`);
}

// The headline excludes renewals: they have no browser session, so a missing id there says nothing at all
// about consent.
const live = [...tally].filter(([k]) => k !== "renewal").reduce((a, [, t]) => ({ total: a.total + t.total, withId: a.withId + t.withId }), { total: 0, withId: 0 });
console.log(`\nExcluding renewals: ${live.withId} of ${live.total} carried a client id → analytics consent was granted for AT LEAST ${pct(live.withId, live.total)} of them.`);
console.log("A missing id is ambiguous (denied / embed not run / ad blocker / no _ga yet), so the true granted rate is higher than this floor, never lower.");
console.log("\nCompare against the share of purchases GA4 gave a real channel to. If this floor is much higher,");
console.log("consent is not what is causing Unassigned — check the GA4 measurement ID on the Tracking page");
console.log("matches the property actually firing on the storefront.");
