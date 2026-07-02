// Durable retry for failed server-side sends. A delivery that fails transiently (5xx / network) is
// queued in DeliveryOutbox as the PLATFORM-READY job (no secrets — those are re-read from settings at
// retry time), then re-sent by the /cron/tick worker with exponential backoff until it succeeds or is
// dead-lettered. This is what turns "best-effort" into "eventually delivered" for the accuracy promise.
import prisma from "../db.server";
import { deliverOne } from "./server-side.server";

// Backoff between attempts, in minutes: 1m, 5m, 30m, 2h, 12h. A job that fails all of these (6 total
// sends: the original + 5 retries) is dead-lettered. Exported for the unit test + the cron summary.
export const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
// How long a drained row is leased (nextAttemptAt pushed out) while it's being processed, so an
// overlapping cron tick can't grab and re-send it. Longer than any single send's timeout.
const LEASE_MINUTES = 5;

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
        payload: JSON.stringify({ event: job.event, clientId: job.clientId ?? null, consent: job.consent ?? null }),
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

  // Lease the claimed rows by pushing nextAttemptAt out, so a cron tick that overlaps this one (a long
  // run + a fresh fire) won't re-select the same rows and send the conversion twice. Each row is still
  // re-scheduled to its real backoff below; the lease only covers the in-flight processing window.
  const leaseUntil = minutesFromNow(LEASE_MINUTES);
  await prisma.deliveryOutbox
    .updateMany({ where: { id: { in: due.map((r) => r.id) }, status: "pending" }, data: { nextAttemptAt: leaseUntil } })
    .catch(() => {});

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
  for (const row of due) {
    const settings = await getSettings(row.shopDomain);
    let parsed = {};
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      parsed = {};
    }
    const job = { destination: row.destination, eventName: row.eventName, event: parsed.event, clientId: parsed.clientId, consent: parsed.consent };

    let result = { ok: false, detail: "no settings" };
    if (settings) result = await deliverOne(settings, job).catch((e) => ({ ok: false, detail: e?.message || "error" }));

    if (result.ok) {
      delivered++;
      await prisma.deliveryOutbox.update({ where: { id: row.id }, data: { status: "delivered", attempts: { increment: 1 }, lastDetail: result.detail || null } }).catch(() => {});
      continue;
    }
    const attempts = row.attempts + 1;
    const delay = nextDelayMinutes(attempts);
    if (delay == null) {
      dead++;
      await prisma.deliveryOutbox.update({ where: { id: row.id }, data: { status: "dead", attempts, lastDetail: (result.detail || "").slice(0, 200) || null } }).catch(() => {});
    } else {
      requeued++;
      await prisma.deliveryOutbox.update({ where: { id: row.id }, data: { attempts, nextAttemptAt: minutesFromNow(delay), lastDetail: (result.detail || "").slice(0, 200) || null } }).catch(() => {});
    }
  }
  return { processed: due.length, delivered, requeued, dead };
}
