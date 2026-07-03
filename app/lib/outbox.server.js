// Durable retry for failed server-side sends. A delivery that fails transiently (5xx / network) is
// queued in DeliveryOutbox as the PLATFORM-READY job (no secrets — those are re-read from settings at
// retry time), then re-sent by the /cron/tick worker with exponential backoff until it succeeds or is
// dead-lettered. This is what turns "best-effort" into "eventually delivered" for the accuracy promise.
import crypto from "node:crypto";
import prisma from "../db.server";
import { deliverOne, numericId } from "./server-side.server";
import { recordCapture, recordDeliveries, CAPTURE_FLAG_BY_DESTINATION } from "./delivery.server";
import { encryptSecret, decryptSecret } from "./secrets.server";

/** The numeric order id a queued purchase job carries, so a successful retry can stamp PurchaseCapture
 *  and stop the reconcile pass from re-sending (double-counting) the same purchase. Reads the order id
 *  from wherever each destination's built event stores it. Pure. */
function purchaseOrderId(destination, event) {
  if (destination === "ga4") return numericId(event?.params?.transaction_id);
  if (destination === "meta") return numericId(event?.custom_data?.order_id) || numericId(event?.event_id);
  if (destination === "google_ads") return numericId(event?.orderId);
  if (destination === "reddit") return numericId(event?.event_metadata?.conversion_id);
  return null;
}

// Backoff between attempts, in minutes: 1m, 5m, 30m, 2h, 12h. A job that fails all of these (6 total
// sends: the original + 5 retries) is dead-lettered. Exported for the unit test + the cron summary.
export const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
// How long a drained row is leased (nextAttemptAt pushed out) while it's being processed, so an
// overlapping cron tick can't grab and re-send it.
//
// INVARIANT: the lease MUST outlast the whole batch, not just one send. Rows are processed sequentially,
// so worst-case batch time = (cron limit) × (per-send timeout). With net.DEFAULT_TIMEOUT_MS = 10s and the
// cron's drainOutbox limit (40) → ≤ ~6.7 min < this 10-min lease. If you raise the cron limit or the
// timeout, keep (limit × timeout) < LEASE_MINUTES, or a stuck batch's un-reached rows go due again mid-
// tick and an overlapping tick re-sends them (double-counting non-purchase GA4 events, which don't dedup).
const LEASE_MINUTES = 10;

/** Minutes until the next attempt for a row that has already been tried `attempts` times, or null if
 *  it has exhausted its retries (→ caller marks it dead). Pure. */
export function nextDelayMinutes(attempts) {
  if (attempts >= MAX_ATTEMPTS) return null;
  return BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1];
}

const minutesFromNow = (m) => new Date(Date.now() + m * 60_000);

/** Queue one failed job for retry. `detail` is the failure reason for the health log. Best-effort. */
export async function enqueue(shopDomain, job, detail = "") {
  if (!shopDomain || !job?.destination || !job?.event) return;
  await prisma.deliveryOutbox
    .create({
      data: {
        shopDomain,
        destination: job.destination,
        eventName: job.eventName || job.event?.name || "event",
        // Encrypt at rest (AES-256-GCM). A queued job can carry personal data — the ad CAPIs hash PII,
        // but Klaviyo events carry RAW email/phone (Klaviyo matches profiles on the raw value), so a
        // plaintext payload would sit unencrypted in the DB. decryptSecret reads legacy plaintext rows
        // back unchanged, so this is backward-compatible with anything already queued.
        payload: encryptSecret(JSON.stringify({ event: job.event, clientId: job.clientId ?? null, consent: job.consent ?? null })),
        attempts: 1, // the live send already counts as attempt #1
        status: "pending",
        lastDetail: (detail || "").slice(0, 200) || null,
        nextAttemptAt: minutesFromNow(BACKOFF_MINUTES[0]),
      },
    })
    .catch(() => {});
}

/** Queue every failed result from a fan-out (results carry their originating `job`). Best-effort. */
export async function enqueueFailures(shopDomain, results) {
  const failed = (results || []).filter((r) => r && !r.ok && r.job);
  await Promise.all(failed.map((r) => enqueue(shopDomain, r.job, r.detail)));
}

/**
 * Retry due outbox rows: re-read each shop's settings, re-send via deliverOne, then either mark the
 * row delivered, schedule the next backoff, or dead-letter it once retries are exhausted. Returns a
 * summary for the cron log. Called by /cron/tick.
 */
export async function drainOutbox({ limit = 200 } = {}) {
  const due = await prisma.deliveryOutbox
    .findMany({
      where: { status: "pending", nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: "asc" },
      take: limit,
    })
    .catch(() => []);
  if (!due.length) return { processed: 0, delivered: 0, requeued: 0, dead: 0 };

  // Lease the batch with a compare-and-swap: stamp a unique token on the still-due rows and push
  // nextAttemptAt out. Because the lease WHERE also requires `nextAttemptAt <= now`, a concurrent tick
  // that already leased a row (pushing it to the future) can't match it again — Postgres row locks
  // serialize the two UPDATEs, so exactly one token lands per row. We then re-select ONLY the rows
  // carrying our token and process just those, so two overlapping ticks never re-send the same row.
  const leaseToken = crypto.randomUUID();
  const leaseUntil = minutesFromNow(LEASE_MINUTES);
  const ids = due.map((r) => r.id);
  await prisma.deliveryOutbox
    .updateMany({ where: { id: { in: ids }, status: "pending", nextAttemptAt: { lte: new Date() } }, data: { nextAttemptAt: leaseUntil, leaseToken } })
    .catch(() => {});
  const claimed = await prisma.deliveryOutbox.findMany({ where: { id: { in: ids }, leaseToken } }).catch(() => []);
  if (!claimed.length) return { processed: 0, delivered: 0, requeued: 0, dead: 0 };

  // Cache settings per shop across this batch (many rows usually share a shop).
  const settingsCache = new Map();
  const getSettings = async (shopDomain) => {
    if (!settingsCache.has(shopDomain)) {
      settingsCache.set(shopDomain, await prisma.trackingSettings.findUnique({ where: { shopDomain } }).catch(() => null));
    }
    return settingsCache.get(shopDomain);
  };

  let delivered = 0;
  let requeued = 0;
  let dead = 0;
  for (const row of claimed) {
    const settings = await getSettings(row.shopDomain);
    let parsed = null;
    try {
      parsed = JSON.parse(decryptSecret(row.payload));
    } catch {
      parsed = null;
    }
    // A row we can't decrypt/parse (wrong-key rotation, truncation, tampering) has no recoverable event.
    // Dead-letter it instead of posting `{events:[undefined]}` — which GA4 would 204 (looking delivered)
    // while the real conversion is silently lost. A dead row is visible in diagnostics; a false-delivered
    // one is not.
    if (!parsed || parsed.event == null) {
      dead++;
      await prisma.deliveryOutbox.update({ where: { id: row.id }, data: { status: "dead", lastDetail: "corrupt payload (undecryptable/missing event)", leaseToken: null } }).catch(() => {});
      continue;
    }
    const job = { destination: row.destination, eventName: row.eventName, event: parsed.event, clientId: parsed.clientId, consent: parsed.consent };

    let result = { ok: false, detail: "no settings" };
    if (settings) result = await deliverOne(settings, job).catch((e) => ({ ok: false, detail: e?.message || "error" }));

    if (result.ok) {
      delivered++;
      await prisma.deliveryOutbox.update({ where: { id: row.id }, data: { status: "delivered", attempts: { increment: 1 }, lastDetail: result.detail || null, leaseToken: null } }).catch(() => {});
      // A recovered purchase send MUST stamp PurchaseCapture, or the reconcile pass (which only checks
      // capture flags, not the outbox) will re-send this same order to that destination and double-count.
      const flag = CAPTURE_FLAG_BY_DESTINATION[row.destination];
      if (row.eventName === "checkout_completed" && flag) {
        const oid = purchaseOrderId(row.destination, job.event);
        if (oid) await recordCapture(row.shopDomain, oid, { [flag]: true });
      }
      // Health parity: log the recovered send + bump eventsSent (countPurchases:false — the order was
      // already counted, or not, at first ingest; re-counting here would inflate the capture rate).
      await recordDeliveries(row.shopDomain, [{ destination: row.destination, eventName: row.eventName, ok: true, detail: result.detail || "" }], { countPurchases: false });
      continue;
    }
    const attempts = row.attempts + 1;
    const delay = nextDelayMinutes(attempts);
    // Clear the lease on every terminal transition so a finished row never carries a dangling token
    // (lets leaseToken double as a liveness signal, and keeps re-selects unambiguous).
    if (delay == null) {
      dead++;
      await prisma.deliveryOutbox.update({ where: { id: row.id }, data: { status: "dead", attempts, lastDetail: (result.detail || "").slice(0, 200) || null, leaseToken: null } }).catch(() => {});
    } else {
      requeued++;
      await prisma.deliveryOutbox.update({ where: { id: row.id }, data: { attempts, nextAttemptAt: minutesFromNow(delay), lastDetail: (result.detail || "").slice(0, 200) || null, leaseToken: null } }).catch(() => {});
    }
  }
  return { processed: claimed.length, delivered, requeued, dead };
}
