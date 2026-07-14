// Historical revenue-by-channel backfill (IO). Pages Shopify's order history, reads the channel from
// Shopify's OWN attribution (Order.customerJourneySummary.firstVisit), rebuilds ChannelRevenueDaily, and
// populates CustomerAttribution so future renewals inherit the right channel too.
//
// Why it exists: ChannelRevenueDaily only fills from orders/paid going forward. A subscription business's
// key question — "which channel acquired the subscribers whose renewals are paying us now?" — is answered
// by orders placed long before the app was installed.
//
// ⚠️ The 60-day wall: `read_orders` only exposes the last 60 days. Reaching an established subscriber's
// ACQUIRING order (often years back) needs `read_all_orders`, which Shopify must approve. Without it the
// backfill still runs, but those customers resolve to "(unattributed)" — we never fold them into
// "(direct)", which would inflate the best-looking channel and mislead the person reading the report.
//
// Safety: leased (like the rest of the cron work) so two ticks can't run it twice; resumable via the
// Shopify page cursor; and on a FRESH start it clears the window first, so a re-run can't double-count.
// It only ever touches days < today — the live orders/paid path owns today onward, so they never overlap.
import crypto from "node:crypto";
import prisma from "../db.server";
import { foldOrders, mergeUnattributed, emptyUnattributed } from "./backfill";

const LEASE_MINUTES = 10;
// Orders per Shopify page. NOT raised beyond 100: each node also pulls a customer journey + up to 50 line
// items, and Shopify prices a nested connection as parent×child — so 250 would multiply the query cost and
// start tripping the per-query cost ceiling. 100 is the known-good size; we get throughput from more PAGES
// per tick instead, which costs the same per order but pipelines better against the leaky bucket.
const PAGE_SIZE = 100;
// Max pages per cron tick — the hard ceiling. The real limiter is TIME_BUDGET_MS below.
const MAX_PAGES_PER_TICK = 30;
// Wall-clock budget for one tick's paging. This is the safety-critical number, bounded by THREE things:
//   • Cloudflare cuts the cron HTTP request at ~100s, and the tick's other jobs share that budget.
//   • The job lease is 10 min; the budget must stay far below it or an overlapping tick could re-claim the
//     job mid-flight and double-count.
//   • Shopify's leaky-bucket throttles us anyway once we outrun the restore rate.
// 45s leaves comfortable headroom on all three while lifting the ceiling from 500 to ~3,000 orders/tick.
const TIME_BUDGET_MS = 45_000;

const todayUtc = () => new Date().toISOString().slice(0, 10);

const ORDERS_QUERY = `#graphql
  query BackfillOrders($cursor: String, $query: String) {
    orders(first: ${PAGE_SIZE}, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        sourceName
        app { name }
        currentTotalPriceSet { shopMoney { amount } }
        customer { id }
        customerJourneySummary {
          firstVisit {
            source
            referrerUrl
            utmParameters { source medium campaign }
          }
        }
        lineItems(first: 50) { nodes { sellingPlan { name } } }
      }
    }
  }
`;

/** Flatten a Shopify GraphQL order node into the shape foldOrders (pure) expects. */
function toOrder(node) {
  return {
    id: node?.id,
    name: node?.name || null,
    createdAt: node?.createdAt,
    // The human-readable origin, matching Shopify's admin "Source" column: the creating app's name
    // ("Matrixify App" for an import, "Online Store" for web) falls back to the raw sourceName.
    source: node?.app?.name || node?.sourceName || null,
    totalPrice: Number(node?.currentTotalPriceSet?.shopMoney?.amount) || 0,
    customer: node?.customer ? { id: node.customer.id } : null,
    customerJourneySummary: node?.customerJourneySummary || null,
    lineItems: (node?.lineItems?.nodes || []).map((l) => ({ sellingPlan: l?.sellingPlan || null })),
  };
}

// How far back to SCAN, to learn each customer's acquiring channel. Much deeper than the revenue window on
// purpose: a subscriber acquired 2 years ago still renews today, and their acquiring order is the ONLY one
// that ever carried a customer journey. 3 years covers essentially any live subscription cohort. Requires
// read_all_orders (past 60 days); without it Shopify just returns less and the job still completes.
const HISTORY_DAYS = 1095;

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Queue a backfill for a shop (idempotent — a running job is left alone). */
export async function requestBackfill(shopDomain, { days = 90, historyDays = HISTORY_DAYS } = {}) {
  const since = daysAgo(days); // revenue window (what the report shows)
  const historySince = daysAgo(Math.max(historyDays, days)); // scan window (to learn first touch)
  const existing = await prisma.backfillJob.findUnique({ where: { shopDomain } }).catch(() => null);
  if (existing?.status === "running") return { queued: false, detail: "already running" };
  const fresh = {
    status: "running",
    sinceDate: since,
    historySince,
    cursor: null,
    ordersProcessed: 0,
    // breakdown reset too — a re-run must not accumulate on top of the previous run's counters.
    breakdown: "{}",
    detail: null,
    startedAt: new Date(),
    finishedAt: null,
  };
  await prisma.backfillJob
    .upsert({ where: { shopDomain }, create: { shopDomain, ...fresh }, update: fresh })
    .catch(() => {});
  return { queued: true, since, historySince };
}

/** Clear the window we're about to rebuild, so a re-run can't double-count. Days < today only. */
async function clearWindow(shopDomain, sinceDate) {
  await prisma.channelRevenueDaily
    .deleteMany({ where: { shopDomain, date: { gte: sinceDate, lt: todayUtc() } } })
    .catch(() => {});
  // The per-order (unattributed) list is rebuilt from scratch too, or a re-run would show stale/duplicate
  // orders. Upsert-by-orderId would dedupe within a run, but only deleting the window matches clearWindow's
  // contract that a fresh start starts fresh.
  await prisma.unattributedOrder
    .deleteMany({ where: { shopDomain, date: { gte: sinceDate, lt: todayUtc() } } })
    .catch(() => {});
}

/**
 * Persist a page's aggregates (increment) + first-touch learned (create-only) + the (unattributed) orders.
 * Runs on `db`, which is a Prisma transaction client so the whole page commits atomically with the cursor
 * advance (see the caller). Errors PROPAGATE — a failed write must roll the page back, not be swallowed,
 * or the increments could land without the cursor moving and double-count on retry.
 */
async function persist(db, shopDomain, rows, learned, unattributedOrders = []) {
  // The individual (unattributed) orders — upsert by orderId so a re-processed page (lease expiry, retry)
  // can't duplicate them, unlike the increment-based aggregate rows.
  for (const o of unattributedOrders) {
    if (!o.orderId) continue;
    const data = {
      name: o.name,
      date: o.date,
      revenue: o.revenue,
      isSubscription: o.isSubscription,
      source: o.source,
      migrated: o.migrated,
      reason: o.reason,
      customerKey: o.customerKey,
    };
    await db.unattributedOrder.upsert({ where: { shopDomain_orderId: { shopDomain, orderId: o.orderId } }, create: { shopDomain, orderId: o.orderId, ...data }, update: data });
  }
  for (const r of rows) {
    await db.channelRevenueDaily.upsert({
      where: { shopDomain_date_source_medium: { shopDomain, date: r.date, source: r.source, medium: r.medium } },
      create: {
        shopDomain,
        date: r.date,
        source: r.source,
        medium: r.medium,
        orders: r.orders,
        revenue: r.revenue,
        subscriptionOrders: r.subscriptionOrders,
        subscriptionRevenue: r.subscriptionRevenue,
      },
      update: {
        orders: { increment: r.orders },
        revenue: { increment: r.revenue },
        subscriptionOrders: { increment: r.subscriptionOrders },
        subscriptionRevenue: { increment: r.subscriptionRevenue },
      },
    });
  }
  // Seed CustomerAttribution so FUTURE renewals inherit the acquiring channel. `create`-only: never
  // clobber a first touch the live pipeline already captured (it saw the real visit; we're inferring).
  for (const l of learned) {
    await db.customerAttribution.upsert({
      where: { shopDomain_customerKey: { shopDomain, customerKey: l.customerKey } },
      create: { shopDomain, customerKey: l.customerKey, source: l.source, medium: l.medium, campaign: l.campaign, firstOrderId: l.firstOrderId },
      update: {}, // no-op — an existing first touch always wins
    });
  }
}

/**
 * Cron pass: advance the backfill a few pages. Leased, resumable, best-effort.
 * Returns a summary for the tick log.
 */
export async function processBackfill({ pages = MAX_PAGES_PER_TICK, budgetMs = TIME_BUDGET_MS } = {}) {
  const now = new Date();
  const job = await prisma.backfillJob
    .findFirst({ where: { status: "running", OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] } })
    .catch(() => null);
  if (!job) return { ran: 0 };

  // Lease it (compare-and-swap on the token) so an overlapping tick can't page the same job.
  const token = crypto.randomUUID();
  const leased = await prisma.backfillJob
    .updateMany({
      where: { shopDomain: job.shopDomain, status: "running", OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] },
      data: { leaseToken: token, leasedUntil: new Date(Date.now() + LEASE_MINUTES * 60 * 1000) },
    })
    .catch(() => ({ count: 0 }));
  if (!leased.count) return { ran: 0 };

  const shopDomain = job.shopDomain;
  let cursor = job.cursor;
  let processed = job.ordersProcessed || 0;
  // Accumulated across ticks — a fresh run resets it to {} in requestBackfill.
  let unattributed = (() => {
    try {
      return { ...emptyUnattributed(), ...JSON.parse(job.breakdown || "{}") };
    } catch {
      return emptyUnattributed();
    }
  })();

  try {
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shopDomain);

    // Fresh start → clear the window so a re-run is idempotent.
    if (!cursor) await clearWindow(shopDomain, job.sinceDate);

    // Carry first-touch across pages IN MEMORY within this tick, and fall back to CustomerAttribution for
    // customers first seen on an earlier tick (that's what makes it resumable and still correct).
    const firstTouch = new Map();
    const seeded = await prisma.customerAttribution.findMany({ where: { shopDomain } }).catch(() => []);
    for (const c of seeded) {
      if (c.source) firstTouch.set(c.customerKey, { source: c.source, medium: c.medium, campaign: c.campaign });
    }

    // Scan from historySince (deep — to LEARN each customer's acquiring channel), not from sinceDate.
    // foldOrders only aggregates REVENUE from sinceDate onward, so the extra history teaches us first-touch
    // without inflating the report with orders outside the window it covers.
    // `financial_status:paid` mirrors the orders/paid webhook, so backfilled history and live data count the
    // same orders. Bounded to days < today: the live path owns today.
    const scanFrom = job.historySince || job.sinceDate;
    const query = `created_at:>=${scanFrom} created_at:<${todayUtc()} financial_status:paid`;

    let hasNext = true;
    let pagesRun = 0;
    const deadline = Date.now() + budgetMs;

    // Page until we run out of orders, pages, or clock. Stopping early is always safe: the cursor is
    // persisted, so the next tick resumes exactly where this one left off.
    while (hasNext && pagesRun < pages && Date.now() < deadline) {
      const res = await admin.graphql(ORDERS_QUERY, { variables: { cursor, query } });
      const json = await res.json();
      const conn = json?.data?.orders;
      if (!conn) {
        const msg = json?.errors?.[0]?.message || "orders query failed";
        // Throttled: we've outrun Shopify's leaky bucket. NOT an error — bank the progress we made and let
        // the next tick pick it up from the stored cursor. Erroring here would strand the whole job.
        if (/throttl/i.test(msg) || json?.errors?.[0]?.extensions?.code === "THROTTLED") break;
        // Surface a missing scope as itself, not as an opaque failure — this is the single most likely
        // reason a backfill won't run, and "Access denied for customer field" is meaningless to a merchant.
        if (/access denied|required access/i.test(msg)) {
          throw new Error(
            `${msg} — the app needs read_orders, read_all_orders and read_customers. Re-deploy and re-approve the app, then run the backfill again.`,
          );
        }
        throw new Error(msg);
      }

      const orders = (conn.nodes || []).map(toOrder);
      // revenueSince gates REVENUE only — first touch is still learned from every order we scan.
      const { rows, learned, unattributed: pageUnattributed, unattributedOrders } = foldOrders(orders, firstTouch, { revenueSince: job.sinceDate });

      // Next-page state, held in locals until the write commits — so a failure leaves cursor/processed at
      // their last committed values and the page simply re-runs next tick.
      const nextCursor = conn.pageInfo?.endCursor || null;
      const nextProcessed = processed + orders.length;
      const nextBreakdown = mergeUnattributed(unattributed, pageUnattributed);

      // THE hardening: the page's data writes and the cursor advance commit in ONE transaction. Previously
      // persist() incremented ChannelRevenueDaily and the cursor was saved in a separate write afterwards —
      // a container death (deploy, OOM) between the two re-ran the page from the old cursor and
      // double-incremented ~a page of orders. Atomic now: either both land or neither does.
      try {
        await prisma.$transaction(
          async (tx) => {
            await persist(tx, shopDomain, rows, learned, unattributedOrders);
            await tx.backfillJob.updateMany({
              where: { shopDomain, leaseToken: token },
              data: { cursor: nextCursor, ordersProcessed: nextProcessed, breakdown: JSON.stringify(nextBreakdown) },
            });
          },
          { timeout: 20_000, maxWait: 10_000 },
        );
      } catch {
        // Nothing committed. Stop the loop without advancing; the next tick resumes from the stored cursor.
        // Better than marking the whole job errored on a transient DB blip.
        break;
      }

      // Committed — advance in-memory state to match what's now persisted.
      cursor = nextCursor;
      processed = nextProcessed;
      unattributed = nextBreakdown;
      hasNext = !!conn.pageInfo?.hasNextPage;
      pagesRun += 1;
    }

    const done = !hasNext;
    await prisma.backfillJob
      .updateMany({
        where: { shopDomain, leaseToken: token },
        data: {
          status: done ? "done" : "running",
          cursor: done ? null : cursor,
          ordersProcessed: processed,
          breakdown: JSON.stringify(unattributed),
          leaseToken: null,
          leasedUntil: null,
          ...(done ? { finishedAt: new Date(), detail: `${processed} orders` } : {}),
        },
      })
      .catch(() => {});
    return { ran: 1, shop: shopDomain, processed, done };
  } catch (e) {
    // A backfill failure must never wedge the tick — record it and release the lease.
    await prisma.backfillJob
      .updateMany({
        where: { shopDomain, leaseToken: token },
        data: { status: "error", detail: String(e?.message || e).slice(0, 300), leaseToken: null, leasedUntil: null, finishedAt: new Date() },
      })
      .catch(() => {});
    return { ran: 1, shop: shopDomain, error: String(e?.message || e).slice(0, 200) };
  }
}

/** Current backfill state for the Attribution page. */
export async function backfillStatus(shopDomain) {
  return prisma.backfillJob.findUnique({ where: { shopDomain } }).catch(() => null);
}
