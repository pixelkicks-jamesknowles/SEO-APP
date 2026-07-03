import prisma from "../db.server";

const today = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

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
export async function recordDeliveries(shopDomain, results) {
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
  const purchaseDelivered = results.some((r) => r.ok && (r.eventName === "checkout_completed" || r.isPurchase));
  await bumpDaily(shopDomain, {
    eventsSent: ok,
    eventsFailed: failed,
    ...(purchaseDelivered ? { purchasesDelivered: 1 } : {}),
  });
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
