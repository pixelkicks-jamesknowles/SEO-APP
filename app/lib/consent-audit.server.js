// Runs the historical consent audit against the Admin API, on demand from the Accuracy page.
//
// Deliberately NOT a leased cron job like the backfills. This answers a question ("did shoppers actually
// consent, historically?") rather than building state, it writes nothing, and a merchant asking it wants an
// answer on the page rather than in ten minutes. So it runs INLINE with a hard time budget and reports how
// far it got.
//
// Newest-first (`reverse: true`), which is the opposite of the revenue backfill and deliberate: a partial
// scan should cover the MOST RECENT orders, since that is the period anyone is comparing against a GA4
// report. A truncated run is a recent sample, not a random one.
import { foldConsentAudit, summarizeConsentAudit } from "./consent-audit";

const PAGE_SIZE = 100;
// Inline in a request, so the budget is what keeps the embedded app responsive. ~15s leaves room for the
// loader work around it and stays well inside Shopify's admin iframe patience. A store big enough to hit
// this gets a recent sample, which is enough to answer the question.
const TIME_BUDGET_MS = 15_000;
const MAX_PAGES = 25; // ceiling; the clock normally stops it first

const AUDIT_QUERY = `#graphql
  query ConsentAudit($cursor: String, $query: String) {
    orders(first: ${PAGE_SIZE}, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        tags
        customAttributes { key value }
        lineItems(first: 10) { nodes { sellingPlan { name } } }
      }
    }
  }`;

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Page recent paid orders and tally how many carry a ga_client_id. Returns the summary plus `complete`,
 * which is false when the budget stopped it early — the UI must say so, or a sample reads as a census.
 * Best-effort: any Admin failure returns what was counted so far with an `error`.
 */
export async function runConsentAudit(admin, { days = 28, budgetMs = TIME_BUDGET_MS, pages = MAX_PAGES } = {}) {
  const since = daysAgo(days);
  const query = `created_at:>=${since} financial_status:paid`;
  const deadline = Date.now() + budgetMs;
  const tally = {};
  let cursor = null;
  let hasNext = true;
  let pagesRun = 0;
  let error = null;

  while (hasNext && pagesRun < pages && Date.now() < deadline) {
    let conn = null;
    try {
      const res = await admin.graphql(AUDIT_QUERY, { variables: { cursor, query } });
      const body = await res.json();
      conn = body?.data?.orders;
      if (!conn) {
        const msg = body?.errors?.[0]?.message || "orders query failed";
        // read_all_orders is only needed past 60 days; say so rather than surfacing Shopify's wording.
        error = /access denied|required access/i.test(msg)
          ? `${msg} — this needs read_orders (and read_all_orders to look back beyond 60 days).`
          : msg;
        break;
      }
    } catch (e) {
      error = String(e?.message || e).slice(0, 200);
      break;
    }
    foldConsentAudit(conn.nodes || [], tally);
    cursor = conn.pageInfo?.endCursor || null;
    hasNext = !!conn.pageInfo?.hasNextPage;
    pagesRun += 1;
  }

  return { ...summarizeConsentAudit(tally), since, days, complete: !hasNext && !error, ...(error ? { error } : {}) };
}
