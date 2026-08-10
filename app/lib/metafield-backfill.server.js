// Historical attribution write-back. The live orders/paid path stamps connect_analytics.* metafields on
// every NEW order; this pages a merchant's ORDER HISTORY and stamps the same metafields onto past orders,
// so their native Shopify reports show the resolved channel for history too (a subscription business's key
// question is historical). It reads each customer's learned first-touch from CustomerAttribution (populated
// by the revenue backfill), so run it AFTER that job. Resumable + leased exactly like BackfillJob, and every
// write is an idempotent metafieldsSet upsert, so a re-run (or a mid-page throttle break) never double-writes.
import crypto from "node:crypto";
import prisma from "../db.server";
import { numericId } from "./server-side.server";
import { orderTypeOf, customerTypeOf } from "./subscription";
import { writeOrderAttribution, writeCustomerAttribution, attributionValues } from "./report-writeback.server";

const PAGE_SIZE = 25; // each order costs one metafieldsSet mutation, so keep pages small vs the leaky bucket
const MAX_PAGES_PER_TICK = 8;
const TIME_BUDGET_MS = 30_000;
const LEASE_MINUTES = 15;
const HISTORY_DAYS = 1095;

const todayUtc = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const ORDERS_QUERY = `#graphql
  query MetafieldBackfillOrders($cursor: String, $query: String) {
    orders(first: ${PAGE_SIZE}, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        createdAt
        tags
        customAttributes { key value }
        customer { id numberOfOrders }
        lineItems(first: 50) { nodes { sellingPlan { name } } }
      }
    }
  }`;

/** Queue a metafield backfill (idempotent — a running job is left alone). */
export async function requestMetafieldBackfill(shopDomain, { historyDays = HISTORY_DAYS } = {}) {
  const existing = await prisma.metafieldBackfillJob.findUnique({ where: { shopDomain } }).catch(() => null);
  if (existing?.status === "running") return { queued: false, detail: "already running" };
  const fresh = {
    status: "running",
    historySince: daysAgo(historyDays),
    cursor: null,
    ordersProcessed: 0,
    metafieldsWritten: 0,
    detail: null,
    startedAt: new Date(),
    finishedAt: null,
    leaseToken: null,
    leasedUntil: null,
  };
  await prisma.metafieldBackfillJob
    .upsert({ where: { shopDomain }, create: { shopDomain, ...fresh }, update: fresh })
    .catch(() => {});
  return { queued: true };
}

export async function metafieldBackfillStatus(shopDomain) {
  return prisma.metafieldBackfillJob.findUnique({ where: { shopDomain } }).catch(() => null);
}

// Map a GraphQL order node → the REST-ish shape the pure classifiers consume. Deliberately OMITS
// customer.orders_count: numberOfOrders is the customer's CURRENT total, not their count at the time of a
// historical order, so using it would mislabel old orders. We classify new-vs-returning from firstOrderId
// instead (isFirstOrder), which is accurate for history.
function toClassifiable(node) {
  return {
    tags: Array.isArray(node?.tags) ? node.tags.join(",") : node?.tags || "",
    note_attributes: (node?.customAttributes || []).map((a) => ({ name: a.key, value: a.value })),
    line_items: (node?.lineItems?.nodes || []).map((n) => ({ sellingPlan: n?.sellingPlan || null })),
  };
}

/**
 * Advance a few pages of a merchant-requested metafield backfill. Leased so overlapping ticks can't run it
 * twice; resumable via the stored cursor. On any write failure (throttle / transient) it stops WITHOUT
 * advancing the cursor, so the page re-runs next tick — safe because metafieldsSet is an idempotent upsert.
 * Best-effort; must never wedge the cron tick.
 */
export async function processMetafieldBackfill({ pages = MAX_PAGES_PER_TICK, budgetMs = TIME_BUDGET_MS } = {}) {
  const now = new Date();
  const claimable = await prisma.metafieldBackfillJob
    .findFirst({ where: { status: "running", OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] } })
    .catch(() => null);
  if (!claimable) return { ran: 0 };

  const token = crypto.randomUUID();
  const claim = await prisma.metafieldBackfillJob
    .updateMany({
      where: { shopDomain: claimable.shopDomain, status: "running", OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] },
      data: { leaseToken: token, leasedUntil: new Date(Date.now() + LEASE_MINUTES * 60 * 1000) },
    })
    .catch(() => ({ count: 0 }));
  if (claim.count !== 1) return { ran: 0 }; // another tick claimed it

  const shopDomain = claimable.shopDomain;
  let cursor = claimable.cursor;
  let processed = claimable.ordersProcessed || 0;
  let written = claimable.metafieldsWritten || 0;

  try {
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shopDomain);

    // Each customer's learned first-touch + acquiring order, keyed by BOTH the raw stored key and its
    // numeric id, so a lookup works whether the key is a GID (backfill) or a bare id (live path).
    const attrByKey = new Map();
    const seeded = await prisma.customerAttribution.findMany({ where: { shopDomain } }).catch(() => []);
    for (const c of seeded) {
      attrByKey.set(c.customerKey, c);
      const n = numericId(c.customerKey);
      if (n) attrByKey.set(n, c);
    }
    const lookupAttr = (gid) => attrByKey.get(gid) || attrByKey.get(numericId(gid)) || null;

    const scanFrom = claimable.historySince || daysAgo(HISTORY_DAYS);
    const query = `created_at:>=${scanFrom} created_at:<${todayUtc()} financial_status:paid`;

    let hasNext = true;
    let pagesRun = 0;
    let stalled = false;
    const deadline = Date.now() + budgetMs;

    while (hasNext && pagesRun < pages && Date.now() < deadline && !stalled) {
      const res = await admin.graphql(ORDERS_QUERY, { variables: { cursor, query } });
      const jsonRes = await res.json();
      const conn = jsonRes?.data?.orders;
      if (!conn) {
        const msg = jsonRes?.errors?.[0]?.message || "orders query failed";
        if (/throttl/i.test(msg) || jsonRes?.errors?.[0]?.extensions?.code === "THROTTLED") break; // bank progress, resume next tick
        if (/access denied|required access/i.test(msg)) {
          throw new Error(`${msg} — the metafield backfill needs read_all_orders + write_orders. Re-deploy and re-approve, then run it again.`);
        }
        throw new Error(msg);
      }

      const nodes = conn.nodes || [];
      let pageWritten = 0;
      for (const node of nodes) {
        if (Date.now() >= deadline) {
          stalled = true; // ran out of clock mid-page; don't advance the cursor, re-run the page next tick
          break;
        }
        const orderId = numericId(node.id);
        const attr = lookupAttr(node.customer?.id);
        const isFirstOrder = attr?.firstOrderId ? numericId(attr.firstOrderId) === orderId : undefined;
        const order = toClassifiable(node);
        const values = attributionValues({
          source: attr?.source || null,
          medium: attr?.medium || null,
          campaign: attr?.campaign || null,
          orderType: orderTypeOf(order, { isFirstSubscriptionOrder: isFirstOrder }),
          customerType: customerTypeOf(order, { isFirstOrder }),
          // We only know a customer's acquisition date for certain on their FIRST order; leave it unset
          // on later historical orders rather than guess.
          acquisitionDate: isFirstOrder ? node.createdAt : null,
        });
        const r = await writeOrderAttribution(admin, node.id, values);
        if (!r.ok && !r.skipped) {
          stalled = true; // throttle or transient — stop and re-run this page next tick (idempotent)
          break;
        }
        if (r.ok && !r.skipped) pageWritten++;
        // Stamp customer-level traits once, on the acquiring order.
        if (isFirstOrder && node.customer?.id) await writeCustomerAttribution(admin, node.customer.id, values).catch(() => {});
      }

      if (stalled) break; // do NOT advance cursor — the page (partly written, all idempotent) re-runs next tick

      written += pageWritten;
      processed += nodes.length;
      cursor = conn.pageInfo?.endCursor || null;
      hasNext = !!conn.pageInfo?.hasNextPage;
      pagesRun += 1;
      await prisma.metafieldBackfillJob
        .updateMany({ where: { shopDomain, leaseToken: token }, data: { cursor, ordersProcessed: processed, metafieldsWritten: written } })
        .catch(() => {});
    }

    const done = !hasNext && !stalled;
    await prisma.metafieldBackfillJob
      .updateMany({
        where: { shopDomain, leaseToken: token },
        data: {
          status: done ? "done" : "running",
          cursor: done ? null : cursor,
          ordersProcessed: processed,
          metafieldsWritten: written,
          leaseToken: null,
          leasedUntil: null,
          ...(done ? { finishedAt: new Date(), detail: `${written} orders stamped` } : {}),
        },
      })
      .catch(() => {});
    return { ran: 1, shop: shopDomain, processed, written, done };
  } catch (e) {
    await prisma.metafieldBackfillJob
      .updateMany({
        where: { shopDomain, leaseToken: token },
        data: { status: "error", detail: String(e?.message || e).slice(0, 300), leaseToken: null, leasedUntil: null, finishedAt: new Date() },
      })
      .catch(() => {});
    return { ran: 1, shop: shopDomain, error: String(e?.message || e).slice(0, 200) };
  }
}
