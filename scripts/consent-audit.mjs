// Full-history read-only audit: how many past orders show evidence that analytics consent was GRANTED?
//
// The in-app button (Accuracy → "Check historical consent") answers the same question but is time-boxed to
// a recent sample so the page stays responsive. This script exists for the unbounded version: every order
// in the window, however long that takes.
//
// WHY AN INFERENCE IS POSSIBLE AT ALL
// The embed that ran until 2026-09-16 wrote the `ga_client_id` cart attribute only after passing
// `if (!analyticsAllowed()) return;`. Its presence on a historical order is therefore hard evidence that
// analytics consent was granted at that moment. It is the only consent signal those orders carry — the
// `pxp_analytics_consent` attribute was dead code (a duplicate syncCartIds shadowed it), so true consent
// state for them is gone for good.
//
// WHAT IT CANNOT TELL YOU
// The inference runs ONE WAY. A missing ga_client_id is ambiguous: consent denied, the embed never ran, an
// ad blocker, or gtag simply had not written `_ga` yet. So this reports a FLOOR on the granted rate and
// never a denied count. Do not read "no id" as "opted out".
//
// Classification and folding come from the SAME pure module the in-app button uses
// (app/lib/consent-audit.js), so the two can never disagree about what counts as a renewal or as evidence
// of consent.
//
// Writes nothing. Reads orders only.
//
// Env:
//   SHOP          (required)  e.g. naturaw.myshopify.com
//   ADMIN_TOKEN   (required)  Admin API token with read_orders (+ read_all_orders beyond 60 days)
//   DAYS          (optional)  look-back window, default 28 to match a GA4 "Last 28 days" report
//   API_VERSION   (optional)  default 2026-04, matching shopify.app.toml
import { foldConsentAudit, summarizeConsentAudit } from "../app/lib/consent-audit.js";

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

const QUERY = `
  query ConsentAudit($cursor: String, $query: String) {
    orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
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

const tally = {};
let cursor = null;
let scanned = 0;
try {
  for (;;) {
    const conn = await page(cursor);
    const nodes = conn.nodes || [];
    foldConsentAudit(nodes, tally);
    scanned += nodes.length;
    process.stderr.write(`\rscanned ${scanned}…`);
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
} catch (e) {
  console.error(`\nconsent-audit: ${e.message}`);
  process.exit(1);
}

const sum = summarizeConsentAudit(tally);
const pct = (n) => `${n.toFixed(1)}%`;
console.error(`\r${" ".repeat(24)}\r`);
console.log(`Consent audit — ${SHOP}, paid orders since ${since} (${sum.scanned} scanned)\n`);
console.log("order type                 orders    client id            session id");
for (const r of sum.rows) {
  const cid = `${r.withId} (${pct(r.pct)})`;
  const sid = `${r.withSession} (${pct(r.sessionPct)})`;
  console.log(`${r.type.padEnd(24)} ${String(r.total).padStart(7)} ${cid.padStart(18)} ${sid.padStart(21)}`);
}
const live = sum.excludingRenewals;
console.log(`\nExcluding renewals (${live.total} orders):`);
console.log(`  client id  ${live.withId} (${pct(live.floorPct)})  → analytics consent was granted for AT LEAST this many.`);
console.log(`  session id ${live.withSession} (${pct(live.sessionPct)})  → GA4 needs BOTH to give a sale a channel.`);
console.log("\nA missing client id is ambiguous (denied / embed not run / ad blocker / no _ga yet), so the granted");
console.log("rate is higher than that floor, never lower.");

// The two numbers together are the diagnosis. Consent explains Unassigned only if the CLIENT id rate is
// low; if client id is high but session id is not, consent is fine and the session join is what is broken.
if (live.withId > 0 && live.sessionPct < live.floorPct / 2) {
  console.log("\n⚠ Session id is far below client id. Consent is NOT what is causing Unassigned — the embed is");
  console.log("  capturing consent but cannot find the `_ga_<CONTAINER>` cookie, which means the GA4 Measurement");
  console.log("  ID on the Tracking page does not match the property firing on the storefront. Compare the two.");
}

const c = sum.consentSignal;
console.log(
  c.total > 0
    ? `\nExplicit consent attribute present on ${c.total} scanned orders (${c.granted} granted, ${c.denied} declined) — the current embed is live.`
    : "\n⚠ No order scanned carries the explicit consent attribute. It has only been written since the latest theme-extension release, so either that release never reached the storefront or no orders have been placed since it did.",
);
