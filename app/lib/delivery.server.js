import prisma from "../db.server";
import { numericId } from "./server-side.server";

const today = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

// SINGLE SOURCE OF TRUTH: the destinations the reconcile + outbox backfill paths handle, and the
// PurchaseCapture flag each one sets. Every reconciled destination has reliable server-side dedup (GA4
// transaction_id, Meta event_id, Google Ads orderId, Reddit order-scoped conversion_id), so backfilling
// can only fill a gap, never double-count. Adding a reconciled destination means editing ONLY this list.
export const RECONCILED_DESTINATIONS = [
  { destination: "ga4", flag: "ga4" },
  { destination: "meta", flag: "meta" },
  { destination: "google_ads", flag: "googleAds" },
  { destination: "reddit", flag: "reddit" },
];
export const CAPTURE_FLAG_BY_DESTINATION = Object.fromEntries(RECONCILED_DESTINATIONS.map((d) => [d.destination, d.flag]));

/**
 * Mark which destinations have already delivered a purchase for an order (flags only ever flip true).
 * The reconcile pass reads these flags to backfill ONLY the destinations the pixel missed, so stamping
 * a capture is what stops a later backfill from re-sending — and double-counting — a purchase. Lives
 * here (not reconcile) so the outbox retry worker can stamp it too without an import cycle. Best-effort.
 */
export async function recordCapture(shopDomain, orderId, { ga4 = false, meta = false, googleAds = false, reddit = false } = {}) {
  const id = numericId(orderId);
  if (!id || (!ga4 && !meta && !googleAds && !reddit)) return;
  // Flags only ever flip true, so only include the ones being set (never overwrite a true back to false).
  const set = { ...(ga4 ? { ga4: true } : {}), ...(meta ? { meta: true } : {}), ...(googleAds ? { googleAds: true } : {}), ...(reddit ? { reddit: true } : {}) };
  await prisma.purchaseCapture
    .upsert({
      where: { shopDomain_orderId: { shopDomain, orderId: id } },
      create: { shopDomain, orderId: id, ga4, meta, googleAds, reddit },
      update: { ...set, at: new Date() },
    })
    .catch(() => {});
}

/** Derive per-destination capture from a fan-out result set and stamp PurchaseCapture for an order. */
export async function recordCaptureFromResults(shopDomain, orderId, results) {
  const flags = {};
  for (const r of results || []) {
    const flag = CAPTURE_FLAG_BY_DESTINATION[r.destination];
    if (flag && r.ok) flags[flag] = true;
  }
  if (Object.keys(flags).length) await recordCapture(shopDomain, orderId, flags);
}

// Probabilistically trim a capped per-shop log (RecentEvent / DeliveryLog) back to `keep` newest rows.
// Running this on every event would add findMany+deleteMany to every storefront hit; sampling keeps
// the churn low while bounding the table just above the cap. Best-effort. Exported for reuse + tests.
export async function pruneCap(model, shopDomain, keep, probability = 0.05) {
  if (Math.random() >= probability) return;
  const stale = await model
    .findMany({ where: { shopDomain }, orderBy: { createdAt: "desc" }, skip: keep, select: { id: true } })
    .catch(() => []);
  if (stale.length) {
    await model.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } }).catch(() => {});
  }
}

// Increment per-day reconciliation counters for a shop (Accuracy dashboard). Best-effort.
export async function bumpDaily(shopDomain, fields) {
  const date = today();
  const update = {};
  for (const [k, v] of Object.entries(fields)) update[k] = { increment: v };
  await prisma.trackingDaily
    .upsert({ where: { shopDomain_date: { shopDomain, date } }, create: { shopDomain, date, ...fields }, update })
    .catch(() => {});
}

// Record per-destination delivery outcomes (capped 300/shop) + roll up daily counters.
// countPurchases:false suppresses the purchasesDelivered bump — used by the outbox retry worker, where
// the order was already counted (or not) at first ingest, so re-counting it on recovery would inflate
// the per-order capture rate.
export async function recordDeliveries(shopDomain, results, { countPurchases = true } = {}) {
  if (!results?.length) return;
  // Best-effort like every other DB write in the ingest path: a health-log write failure must not abort
  // ingestEvent after the delivery already happened (which would bubble a 500 to the proxy → retry →
  // duplicate send).
  await prisma.deliveryLog
    .createMany({
      data: results.map((r) => ({
        shopDomain,
        destination: r.destination,
        eventName: r.eventName,
        ok: !!r.ok,
        detail: (r.detail || "").slice(0, 200) || null,
      })),
    })
    .catch(() => {});
  // Enforce the ~300/shop cap. Pruning on every event would run findMany+deleteMany per storefront hit
  // (page_viewed fires on every pageview) — heavy write amplification on busy stores. Prune ~5% of the
  // time instead: the log stays bounded a little above the cap, at a fraction of the DB churn.
  await pruneCap(prisma.deliveryLog, shopDomain, 300);

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  // A paid order counts as "captured" when we delivered a purchase-type event: the pixel's
  // checkout_completed, or a server-side subscription purchase (flagged isPurchase). Recurring
  // subscription renewals never fire a storefront checkout, so the orders/paid webhook is the only
  // capture signal for them — without this they'd read as permanent misses in the match rate.
  const purchaseDelivered = countPurchases && results.some((r) => r.ok && (r.eventName === "checkout_completed" || r.isPurchase));
  await bumpDaily(shopDomain, {
    eventsSent: ok,
    eventsFailed: failed,
    ...(purchaseDelivered ? { purchasesDelivered: 1 } : {}),
  });
}

/**
 * Revenue-by-channel: attribute one paid order's revenue to its acquisition channel (first-touch
 * source/medium, else "(direct)"/"(none)") for the Attribution report.
 *
 * Driven from the **orders/paid webhook** — Shopify's source of truth, and the ONLY path that sees
 * recurring subscription renewals. Renewals never fire a storefront checkout, so the pixel/ingest path
 * never saw them and their revenue was missing from this report entirely. A renewal inherits the
 * customer's FIRST-TOUCH source, which is the honest answer to "which channel acquired this subscriber"
 * — and the number GA4 structurally cannot produce (a renewal has no browser session to take a channel
 * from, so GA4 can only ever report it as Unassigned).
 *
 * `isSubscription` splits the row so the report can show subscription vs one-off revenue per channel.
 * Idempotent via the orders/paid ProcessedWebhook gate (one call per order). Best-effort.
 */
export async function recordChannelRevenue(shopDomain, { source, medium, revenue, isSubscription = false } = {}) {
  const rev = Number(revenue) || 0;
  const date = today();
  const src = source || "(direct)";
  const med = medium || "(none)";
  const subOrders = isSubscription ? 1 : 0;
  const subRevenue = isSubscription ? rev : 0;
  await prisma.channelRevenueDaily
    .upsert({
      where: { shopDomain_date_source_medium: { shopDomain, date, source: src, medium: med } },
      create: {
        shopDomain,
        date,
        source: src,
        medium: med,
        orders: 1,
        revenue: rev,
        subscriptionOrders: subOrders,
        subscriptionRevenue: subRevenue,
      },
      update: {
        orders: { increment: 1 },
        revenue: { increment: rev },
        subscriptionOrders: { increment: subOrders },
        subscriptionRevenue: { increment: subRevenue },
      },
    })
    .catch(() => {});
}

// First-touch attribution: record a visitor's source on a UTM-tagged visit (never overwrite the
// first source - later visits only bump the counter). Keyed on GA4 client_id. Low write volume
// (only fires when UTMs are present). Best-effort.
export async function recordVisit(shopDomain, clientId, utm) {
  if (!clientId || !utm) return;
  const source = utm.utm_source || null;
  const medium = utm.utm_medium || null;
  const campaign = utm.utm_campaign || null;
  if (!source && !medium && !campaign) return;
  await prisma.visitorAttribution
    .upsert({
      where: { shopDomain_clientId: { shopDomain, clientId } },
      create: { shopDomain, clientId, source, medium, campaign, lastSource: source, lastMedium: medium, lastCampaign: campaign },
      // First-touch (source/medium/campaign) is never overwritten; last-touch tracks the newest UTM
      // visit and `visits` counts touches — together they give multi-touch attribution.
      update: { visits: { increment: 1 }, lastSource: source, lastMedium: medium, lastCampaign: campaign },
    })
    .catch(() => {});
}

// Match-quality diagnostics: bump the per-day identifier-coverage counters for a purchase. `keys` is
// the set of Meta identifiers the built user_data carried (from metaIdentifierKeys). `purchases` is the
// denominator; each identifier column counts the purchases that carried it → coverage % = col/purchases.
// Meta Event Match Quality is driven by identifier coverage, so this surfaces the actionable gaps
// ("only 12% of purchases carried a phone") without persisting any PII. Best-effort.
const MQ_COLUMNS = ["em", "ph", "fn", "ln", "ct", "st", "zp", "country", "externalId", "fbp", "fbc", "clientIp", "userAgent"];
export async function bumpMatchQuality(shopDomain, keys) {
  const date = today();
  const present = new Set(keys || []);
  const inc = { purchases: { increment: 1 } };
  const create = { shopDomain, date, purchases: 1 };
  for (const col of MQ_COLUMNS) {
    const hit = present.has(col) ? 1 : 0;
    inc[col] = { increment: hit };
    create[col] = hit;
  }
  await prisma.matchQualityDaily
    .upsert({ where: { shopDomain_date: { shopDomain, date } }, create, update: inc })
    .catch(() => {});
}

/** Roll up identifier coverage over the last `days` into { purchases, coverage: { col: pct } }. */
export async function getMatchQuality(shopDomain, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await prisma.matchQualityDaily.findMany({ where: { shopDomain, date: { gte: since } } }).catch(() => []);
  const totals = { purchases: 0 };
  for (const col of MQ_COLUMNS) totals[col] = 0;
  for (const r of rows) {
    totals.purchases += r.purchases;
    for (const col of MQ_COLUMNS) totals[col] += r[col];
  }
  const coverage = {};
  for (const col of MQ_COLUMNS) coverage[col] = totals.purchases ? Math.round((totals[col] / totals.purchases) * 100) : 0;
  return { purchases: totals.purchases, coverage, columns: MQ_COLUMNS };
}

// Look up a visitor's first-touch source by client_id (for enriching a later conversion).
export async function getFirstTouch(shopDomain, clientId) {
  if (!clientId) return null;
  const row = await prisma.visitorAttribution
    .findUnique({ where: { shopDomain_clientId: { shopDomain, clientId } } })
    .catch(() => null);
  if (!row || (!row.source && !row.medium && !row.campaign)) return null;
  return {
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    lastSource: row.lastSource,
    lastMedium: row.lastMedium,
    lastCampaign: row.lastCampaign,
    touchCount: row.visits,
  };
}
