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
import prisma from "../db.server";
import { buildJobs, deliverOne } from "./server-side.server";
import { recordDeliveries } from "./delivery.server";
import { enqueueFailures } from "./outbox.server";

/** Trailing run of digits from an order id (handles a numeric id, a "gid://.../Order/123", etc.). */
export function numericId(x) {
  if (x == null) return null;
  const m = String(x).match(/\d+/g);
  return m ? m[m.length - 1] : null;
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
 * Record a paid order for later reconciliation. Builds the GA4 + Meta jobs NOW (Meta PII hashed at build
 * time) and stores just those two — the destinations with reliable server-side dedup. No-op if the shop
 * isn't delivering server-side or has neither GA4 nor Meta wired for checkout_completed. Idempotent
 * (upsert on shop+order). Best-effort.
 */
export async function recordPendingPurchase(shopDomain, order, settings) {
  if (!settings?.serverSide || !settings?.reconciliation) return;
  const orderId = numericId(order?.id);
  if (!orderId) return;
  const event = orderToTrackingEvent(order);
  const jobs = buildJobs(settings, event); // respects the matrix + configured credentials
  const ga4 = jobs.find((j) => j.destination === "ga4") || null;
  const meta = jobs.find((j) => j.destination === "meta") || null;
  if (!ga4 && !meta) return; // nothing server-side to backfill
  await prisma.pendingPurchase
    .upsert({
      where: { shopDomain_orderId: { shopDomain, orderId } },
      create: { shopDomain, orderId, payload: JSON.stringify({ ga4, meta }), status: "pending" },
      update: {}, // a webhook redelivery must not reopen a row the reconcile pass already closed
    })
    .catch(() => {});
}

/** Mark which destinations have already delivered a purchase for an order (flags only ever flip true). */
export async function recordCapture(shopDomain, orderId, { ga4 = false, meta = false } = {}) {
  const id = numericId(orderId);
  if (!id || (!ga4 && !meta)) return;
  await prisma.purchaseCapture
    .upsert({
      where: { shopDomain_orderId: { shopDomain, orderId: id } },
      create: { shopDomain, orderId: id, ga4, meta },
      update: { ...(ga4 ? { ga4: true } : {}), ...(meta ? { meta: true } : {}), at: new Date() },
    })
    .catch(() => {});
}

/** Derive ga4/meta success from a fan-out result set and stamp PurchaseCapture for an order. */
export async function recordCaptureFromResults(shopDomain, orderId, results) {
  const ga4 = (results || []).some((r) => r.destination === "ga4" && r.ok);
  const meta = (results || []).some((r) => r.destination === "meta" && r.ok);
  if (ga4 || meta) await recordCapture(shopDomain, orderId, { ga4, meta });
}

/**
 * Reconcile pass (called by /cron/tick): for each pending order older than the grace window, deliver any
 * GA4/Meta purchase the pixel never captured, then close the row. Failures are queued to the outbox so a
 * transient outage still resolves. Returns a summary for the cron log.
 */
export async function reconcilePending({ graceMinutes = 20, limit = 200 } = {}) {
  const cutoff = new Date(Date.now() - graceMinutes * 60_000);
  const due = await prisma.pendingPurchase
    .findMany({ where: { status: "pending", createdAt: { lt: cutoff } }, orderBy: { createdAt: "asc" }, take: limit })
    .catch(() => []);
  if (!due.length) return { processed: 0, backfilled: 0, skipped: 0, ga4: 0, meta: 0 };

  const settingsCache = new Map();
  const getSettings = async (shopDomain) => {
    if (!settingsCache.has(shopDomain)) {
      settingsCache.set(shopDomain, await prisma.trackingSettings.findUnique({ where: { shopDomain } }).catch(() => null));
    }
    return settingsCache.get(shopDomain);
  };

  let backfilled = 0;
  let skipped = 0;
  const sent = { ga4: 0, meta: 0 };
  for (const row of due) {
    const key = { shopDomain_orderId: { shopDomain: row.shopDomain, orderId: row.orderId } };
    let jobs = {};
    try {
      jobs = JSON.parse(row.payload);
    } catch {
      jobs = {};
    }
    const cap = await prisma.purchaseCapture.findUnique({ where: key }).catch(() => null);
    const settings = await getSettings(row.shopDomain);
    const toSend = [];
    if (jobs.ga4 && !cap?.ga4) toSend.push(jobs.ga4);
    if (jobs.meta && !cap?.meta) toSend.push(jobs.meta);

    if (!settings?.serverSide || !toSend.length) {
      skipped++;
      await prisma.pendingPurchase
        .update({ where: key, data: { status: "skipped", detail: !toSend.length ? "already captured" : "server-side off" } })
        .catch(() => {});
      continue;
    }

    const results = [];
    for (const job of toSend) {
      const r = await deliverOne(settings, job).catch((e) => ({ ok: false, detail: e?.message || "error" }));
      results.push({ destination: job.destination, eventName: job.eventName || "checkout_completed", ok: !!r.ok, detail: r.detail || "", job, isPurchase: true });
      if (r.ok) sent[job.destination] = (sent[job.destination] || 0) + 1;
    }
    await recordDeliveries(row.shopDomain, results);
    await enqueueFailures(row.shopDomain, results); // transient failures still resolve via the outbox
    await recordCaptureFromResults(row.shopDomain, row.orderId, results);
    const okDests = results.filter((r) => r.ok).map((r) => r.destination);
    await prisma.pendingPurchase
      .update({ where: key, data: { status: "reconciled", detail: okDests.length ? `backfilled ${okDests.join(", ")}` : "backfill failed (queued)" } })
      .catch(() => {});
    backfilled++;
  }
  return { processed: due.length, backfilled, skipped, ...sent };
}
