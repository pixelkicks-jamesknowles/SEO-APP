// Server-side purchase reconciliation — the accuracy backstop.
//
// The storefront pixel misses purchases: ad blockers, the checkout sandbox failing to init, ITP/ETP
// killing the beacon, a flaky network. The outbox only retries sends that were *attempted and failed* —
// it can't recover a purchase whose pixel event never fired at all. This closes that gap.
//
// How it stays safe (can only fill a gap, never double-count):
//   1. orders/paid records every paid order as a PendingPurchase, storing the ALREADY-BUILT GA4 + Meta
//      jobs (Meta's PII is hashed at build time, so — like the outbox — no raw PII is persisted).
//   2. The storefront pixel's checkout_completed delivery (ingest) and the subscription webhook's
//      server-side purchase both stamp PurchaseCapture{ga4,meta} for the order id.
//   3. A delayed cron pass (grace window, default 20 min — long enough for a slow pixel beacon to land)
//      backfills ONLY the destinations a PendingPurchase has no capture for. GA4 dedups on
//      transaction_id (= order id); Meta dedups on a deterministic event_id ("order:<id>"), so even a
//      late pixel event mostly collapses. Result: every paid order reaches GA4/Meta at least once.
import crypto from "node:crypto";
import prisma from "../db.server";
import { buildJobs, deliverOne, numericId } from "./server-side.server";
import { recordDeliveries, bumpDaily, recordCapture, recordCaptureFromResults, RECONCILED_DESTINATIONS } from "./delivery.server";
import { enqueueFailures } from "./outbox.server";
import { fxHooks } from "./fx.server";
import { googleAdsHook } from "./google-ads.server";
import { encryptSecret, decryptSecret } from "./secrets.server";

// How long a leased pending-purchase batch is held while it's being backfilled, so an overlapping cron
// tick can't grab the same rows.
//
// INVARIANT (same as the outbox): the lease MUST outlast the whole batch. Rows are processed
// sequentially and each can attempt up to 4 destinations, so worst-case row time ≈ 4 × per-send timeout,
// and batch time ≈ (cron limit) × 4 × timeout. With net.DEFAULT_TIMEOUT_MS = 10s and the cron's reconcile
// limit (8) → ≤ ~5.3 min < this 10-min lease. Keep (limit × 4 × timeout) < LEASE_MINUTES if you retune.
const LEASE_MINUTES = 10;

// numericId now lives in server-side.server (so the pixel builders share the exact same canonicalization)
// and recordCapture(FromResults) in delivery.server (so the outbox worker can stamp captures without an
// import cycle). Re-exported here to keep the historical import surface (ingest, webhooks, tests) stable.
export { numericId, recordCapture, recordCaptureFromResults };

/** The order value carried by a stored pending-purchase job set, preferring GA4 (params.value), then
 *  Meta (custom_data.value), then Google Ads (conversionValue) / Reddit (event_metadata.value_decimal).
 *  Used for the recovered-revenue rollup. Pure. Returns 0 when absent. */
export function purchaseValueFromJobs(jobs) {
  const candidates = [
    jobs?.ga4?.event?.params?.value,
    jobs?.meta?.event?.custom_data?.value,
    jobs?.google_ads?.event?.conversionValue,
    jobs?.reddit?.event?.event_metadata?.value_decimal,
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && v != null) return n;
  }
  return 0;
}

const mapAddr = (a) =>
  a
    ? {
        firstName: a.first_name,
        lastName: a.last_name,
        city: a.city,
        provinceCode: a.province_code,
        province: a.province,
        zip: a.zip,
        countryCode: a.country_code,
        country: a.country,
      }
    : undefined;

/**
 * Map a Shopify REST order payload → the normalized pixel-shaped `checkout_completed` event the pure
 * builders (extractCommerce / ga4EventFor / metaEventFor) already consume — so reconciliation reuses the
 * exact same payload construction as a live purchase. id = "order:<n>" gives Meta a deterministic,
 * order-scoped event_id; checkout.order.id = the numeric order id gives GA4 the same transaction_id the
 * pixel would have sent (so GA4 collapses the two).
 */
export function orderToTrackingEvent(order) {
  const oid = numericId(order?.id) || String(order?.id ?? "");
  const lineItems = (order?.line_items || []).map((l) => ({
    quantity: l.quantity,
    title: l.title,
    variant: {
      sku: l.sku || undefined,
      id: l.variant_id != null ? String(l.variant_id) : undefined,
      title: l.variant_title || undefined,
      price: { amount: Number(l.price) || 0 },
      product: { id: l.product_id != null ? String(l.product_id) : undefined, title: l.title },
    },
  }));
  return {
    name: "checkout_completed",
    id: `order:${oid}`,
    timestamp: order?.created_at || undefined,
    clientId: null, // filled with a stable id by buildJobs (stableClientId of event.id)
    email: order?.email || order?.customer?.email || undefined,
    phone: order?.phone || order?.customer?.phone || undefined,
    externalId: order?.customer?.id != null ? String(order.customer.id) : undefined,
    data: {
      checkout: {
        order: { id: oid },
        currencyCode: order?.currency,
        totalPrice: { amount: Number(order?.current_total_price ?? order?.total_price ?? 0), currencyCode: order?.currency },
        email: order?.email || undefined,
        phone: order?.phone || undefined,
        shippingAddress: mapAddr(order?.shipping_address),
        billingAddress: mapAddr(order?.billing_address),
        lineItems,
      },
    },
  };
}

/**
 * Record a paid order for later reconciliation. Builds the reconcilable jobs NOW (Meta/Reddit PII hashed
 * at build time) and stores them — GA4, Meta, Google Ads and Reddit, the destinations with reliable
 * server-side dedup. No-op if the shop isn't delivering server-side or has none of those wired for
 * checkout_completed. Idempotent (upsert on shop+order). Best-effort.
 */
export async function recordPendingPurchase(shopDomain, order, settings) {
  if (!settings?.serverSide || !settings?.reconciliation) return;
  const orderId = numericId(order?.id);
  if (!orderId) return;
  const event = orderToTrackingEvent(order);
  // Apply the SAME currency normalization the live ingest path uses, so a backfilled purchase reports
  // the same `value` a pixel-delivered one would (otherwise a multi-currency shop's recovered orders ship
  // raw store-currency amounts while live orders ship normalized ones — inconsistent). The Google Ads
  // hook contributes the google_ads job (buildJobs only emits it when the hook is present).
  const hooks = { ...(await fxHooks(settings)), ...googleAdsHook(settings) };
  const jobs = buildJobs(settings, event, { hooks }); // respects the matrix + configured credentials
  const stored = {};
  for (const { destination } of RECONCILED_DESTINATIONS) {
    const job = jobs.find((j) => j.destination === destination);
    if (job) stored[destination] = job;
  }
  if (!Object.keys(stored).length) return; // nothing server-side to backfill
  await prisma.pendingPurchase
    .upsert({
      where: { shopDomain_orderId: { shopDomain, orderId } },
      create: { shopDomain, orderId, payload: encryptSecret(JSON.stringify(stored)), status: "pending" },
      update: {}, // a webhook redelivery must not reopen a row the reconcile pass already closed
    })
    .catch(() => {});
}

/**
 * Reconcile pass (called by /cron/tick): for each pending order older than the grace window, deliver any
 * GA4/Meta purchase the pixel never captured, then close the row. Failures are queued to the outbox so a
 * transient outage still resolves. Returns a summary for the cron log.
 */
export async function reconcilePending({ graceMinutes = 20, limit = 200 } = {}) {
  const cutoff = new Date(Date.now() - graceMinutes * 60_000);
  const now = new Date();
  const unleased = [{ leasedUntil: null }, { leasedUntil: { lt: now } }];
  const due = await prisma.pendingPurchase
    .findMany({ where: { status: "pending", createdAt: { lt: cutoff }, OR: unleased }, orderBy: { createdAt: "asc" }, take: limit })
    .catch(() => []);
  if (!due.length) return { processed: 0, backfilled: 0, skipped: 0, ga4: 0, meta: 0, google_ads: 0, reddit: 0 };

  // Compare-and-swap lease (same shape as drainOutbox): stamp a unique token + push leasedUntil out on
  // the still-unleased rows, then process ONLY the rows carrying our token. Postgres row locks serialize
  // the two UPDATEs, so two overlapping cron ticks can't both claim a row — which would double-count the
  // recovered revenue of the same order (purchase sends collapse platform-side, but the money metrics
  // don't). Without this the reconcile pass had no concurrency guard at all.
  const leaseToken = crypto.randomUUID();
  const leasedUntil = new Date(Date.now() + LEASE_MINUTES * 60_000);
  // Match the EXACT (shop, order) pairs we just read — PendingPurchase has a composite key, so a naive
  // `shopDomain in […] AND orderId in […]` would cross-match a different shop's order that happens to
  // share an order id. AND-combine the pair set with the still-unleased guard.
  await prisma.pendingPurchase
    .updateMany({
      where: { status: "pending", AND: [{ OR: unleased }, { OR: due.map((r) => ({ shopDomain: r.shopDomain, orderId: r.orderId })) }] },
      data: { leaseToken, leasedUntil },
    })
    .catch(() => {});
  const claimed = await prisma.pendingPurchase.findMany({ where: { leaseToken }, take: limit }).catch(() => []);
  if (!claimed.length) return { processed: 0, backfilled: 0, skipped: 0, ga4: 0, meta: 0, google_ads: 0, reddit: 0 };

  const settingsCache = new Map();
  const getSettings = async (shopDomain) => {
    if (!settingsCache.has(shopDomain)) {
      settingsCache.set(shopDomain, await prisma.trackingSettings.findUnique({ where: { shopDomain } }).catch(() => null));
    }
    return settingsCache.get(shopDomain);
  };

  let backfilled = 0;
  let skipped = 0;
  let recovered = 0;
  let recoveredValue = 0;
  const sent = { ga4: 0, meta: 0, google_ads: 0, reddit: 0 };
  for (const row of claimed) {
    const key = { shopDomain_orderId: { shopDomain: row.shopDomain, orderId: row.orderId } };
    let jobs = {};
    try {
      jobs = JSON.parse(decryptSecret(row.payload));
    } catch {
      jobs = {};
    }
    const cap = await prisma.purchaseCapture.findUnique({ where: key }).catch(() => null);
    const settings = await getSettings(row.shopDomain);
    // Backfill every reconciled destination whose purchase the pixel didn't already capture. GA4/Meta
    // plus Google Ads (orderId dedup) and Reddit (order-scoped conversion_id dedup) — all safe to re-send.
    const toSend = [];
    for (const { destination, flag } of RECONCILED_DESTINATIONS) {
      if (jobs[destination] && !cap?.[flag]) toSend.push(jobs[destination]);
    }

    if (!settings?.serverSide || !toSend.length) {
      skipped++;
      await prisma.pendingPurchase
        .update({ where: key, data: { status: "skipped", detail: !toSend.length ? "already captured" : "server-side off", leaseToken: null, leasedUntil: null } })
        .catch(() => {});
      continue;
    }

    // A purchase the pixel captured NOWHERE (no prior capture on ANY reconciled destination) is a genuine
    // recovery. This drives BOTH the recovered-revenue rollup AND whether we count purchasesDelivered:
    // for a partial backfill the order was already counted at first ingest, so re-counting here would
    // push the capture-rate numerator over 100%.
    const capturedNowhere = !cap?.ga4 && !cap?.meta && !cap?.googleAds && !cap?.reddit;

    const results = [];
    for (const job of toSend) {
      const r = await deliverOne(settings, job).catch((e) => ({ ok: false, detail: e?.message || "error" }));
      results.push({ destination: job.destination, eventName: job.eventName || "checkout_completed", ok: !!r.ok, detail: r.detail || "", job, isPurchase: true });
      if (r.ok) sent[job.destination] = (sent[job.destination] || 0) + 1;
    }
    await recordDeliveries(row.shopDomain, results, { countPurchases: capturedNowhere });
    await enqueueFailures(row.shopDomain, results); // transient failures still resolve via the outbox
    await recordCaptureFromResults(row.shopDomain, row.orderId, results);
    const okDests = results.filter((r) => r.ok).map((r) => r.destination);
    await prisma.pendingPurchase
      .update({ where: key, data: { status: "reconciled", detail: okDests.length ? `backfilled ${okDests.join(", ")}` : "backfill failed (queued)", leaseToken: null, leasedUntil: null } })
      .catch(() => {});
    backfilled++;
    // Recovered-revenue rollup: a fully-missed order we backfilled is revenue that would otherwise be
    // missing from the merchant's analytics/ad platforms entirely. Partial backfills are excluded —
    // counting their revenue would double it against the pixel's own capture and overstate the recovery.
    if (capturedNowhere && okDests.length) {
      recovered++;
      const value = purchaseValueFromJobs(jobs);
      recoveredValue += value;
      await bumpDaily(row.shopDomain, { purchasesRecovered: 1, revenueRecovered: value });
    }
  }
  return { processed: claimed.length, backfilled, skipped, recovered, recoveredValue, ...sent };
}
