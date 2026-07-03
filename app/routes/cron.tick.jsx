// Background worker endpoint, hit on a schedule by a Railway cron service (there's no in-process
// scheduler). Guarded by CRON_SECRET so it can't be triggered by the public. Each tick:
//   1. drains the delivery outbox (retries failed server-side sends with backoff),
//   2. reconciles pending purchases (backfills GA4/Meta for any order the pixel never captured),
//   3. processes pending subscription orders (the deferred orders/paid conversion pipeline),
//   4. refreshes the daily FX snapshot (multi-currency normalization),
//   5. purges stale rows (ProcessedWebhook / DeliveryLog / RecentEvent / finished outbox + purchases),
//   6. pushes tracking-health alerts to each shop's configured webhook (cooldown-deduped).
// Idempotent + best-effort: safe to call as often as the cron fires; a slow destination never wedges it.
import crypto from "node:crypto";
import prisma from "../db.server";
import { drainOutbox } from "../lib/outbox.server";
import { reconcilePending } from "../lib/reconcile.server";
import { processPendingSubscriptions } from "../lib/subscription-cron.server";
import { refreshFxRates } from "../lib/fx.server";
import { runAlerts } from "../lib/alerting.server";

// Constant-time compare of the presented secret against CRON_SECRET (same pattern as pixel-token).
// Header-only: a `?key=` query param would land in access logs / referrers, so the secret must be
// sent in the `x-cron-secret` request header (configure the Railway cron service accordingly).
function authorized(request) {
  const expected = process.env.CRON_SECRET || "";
  if (!expected) return false; // not configured → endpoint is closed
  const presented = request.headers.get("x-cron-secret") || "";
  if (presented.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  } catch {
    return false;
  }
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// Restore the TTL purge the old SEO cron used to do, now that there's a scheduler again.
async function purge() {
  const out = {};
  out.processedWebhooks = (await prisma.processedWebhook.deleteMany({ where: { at: { lt: daysAgo(7) } } }).catch(() => ({ count: 0 }))).count;
  out.deliveryLogs = (await prisma.deliveryLog.deleteMany({ where: { createdAt: { lt: daysAgo(30) } } }).catch(() => ({ count: 0 }))).count;
  out.recentEvents = (await prisma.recentEvent.deleteMany({ where: { createdAt: { lt: daysAgo(7) } } }).catch(() => ({ count: 0 }))).count;
  // Finished outbox rows (delivered/dead) are kept a week for debugging, then dropped.
  out.outbox = (await prisma.deliveryOutbox.deleteMany({ where: { status: { in: ["delivered", "dead"] }, updatedAt: { lt: daysAgo(7) } } }).catch(() => ({ count: 0 }))).count;
  // Closed reconciliation rows + their capture flags: kept a week for debugging, then dropped.
  out.pendingPurchases = (await prisma.pendingPurchase.deleteMany({ where: { status: { in: ["reconciled", "skipped"] }, updatedAt: { lt: daysAgo(7) } } }).catch(() => ({ count: 0 }))).count;
  out.purchaseCaptures = (await prisma.purchaseCapture.deleteMany({ where: { at: { lt: daysAgo(7) } } }).catch(() => ({ count: 0 }))).count;
  // Processed subscription orders (done/skipped) carry an encrypted order payload — kept a week for
  // debugging, then dropped so raw-order PII isn't retained indefinitely.
  out.pendingSubscriptions = (await prisma.pendingSubscription.deleteMany({ where: { status: { in: ["done", "skipped"] }, updatedAt: { lt: daysAgo(7) } } }).catch(() => ({ count: 0 }))).count;
  return out;
}

async function tick() {
  // Reconcile runs AFTER the outbox drain so a purchase whose live send failed has already had a retry
  // this tick; the grace window (20 min) means it's ordered independently of the outbox anyway.
  // Batch limits are bounded so a stuck batch (every send hitting the 10s timeout, processed sequentially)
  // can't outlive the per-batch lease and let an overlapping tick re-claim + re-send its rows. See the
  // LEASE_MINUTES invariant in outbox.server.js / reconcile.server.js. A backlog just drains over more
  // ticks (the cron fires frequently) rather than risking a double-send.
  const [outbox, reconciled, subscriptions, fx, purged, alerts] = await Promise.all([
    drainOutbox({ limit: 40 }),
    reconcilePending({ graceMinutes: 20, limit: 8 }),
    // Deferred orders/paid subscription pipeline. No grace window (unlike reconcile): these should deliver
    // as soon as the next tick fires. Leased like reconcile so overlapping ticks can't double-send.
    processPendingSubscriptions({ limit: 6 }),
    refreshFxRates(),
    purge(),
    // Push tracking-health alerts to each shop's configured webhook (cooldown-deduped). Best-effort:
    // an alerting failure must never wedge the outbox/reconcile work above.
    runAlerts().catch(() => ({ shops: 0, notified: 0 })),
  ]);
  return { ok: true, at: new Date().toISOString(), outbox, reconciled, subscriptions, fx, purged, alerts };
}

export const loader = async ({ request }) => {
  if (!authorized(request)) return new Response("Forbidden", { status: 403 });
  return Response.json(await tick());
};

export const action = async ({ request }) => {
  if (!authorized(request)) return new Response("Forbidden", { status: 403 });
  return Response.json(await tick());
};
