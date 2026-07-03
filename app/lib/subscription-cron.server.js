// Deferred subscription-conversion processing. The orders/paid webhook MUST ACK Shopify well inside its
// 5s timeout, but a subscription order's conversion pipeline is slow — it resolves selling plans (Admin
// API), COGS (Admin API), FX and fires two server-side GA4 events. So the webhook only records a
// PendingSubscription row (the encrypted raw order) and returns 200; this pass — run by /cron/tick —
// does the heavy work off the hot path. Failures go to the delivery outbox, so a recurring renewal (no
// pixel fallback) is still eventually delivered. Leased exactly like reconcilePending so two overlapping
// ticks can't double-send.
import crypto from "node:crypto";
import prisma from "../db.server";
import { buildSubscriptionEvent, buildOrderPurchaseEvent, orderHasSubscription, syntheticClientId, noteAttr, orderHasAnalyticsConsent } from "./subscription";
import { fetchOrderSubscriptions } from "./subscription.server";
import { parseUtms, customerKey } from "./attribution";
import { sendGa4Event, withValueMode } from "./server-side.server";
import { recordDeliveries } from "./delivery.server";
import { enqueue } from "./outbox.server";
import { normalizeForShop } from "./fx.server";
import { recordCapture, orderToTrackingEvent, numericId } from "./reconcile.server";
import { cogsEnabled, resolveOrderCost } from "./cogs.server";
import { encryptSecret, decryptSecret } from "./secrets.server";

// Same lease invariant as reconcilePending/drainOutbox: the lease MUST outlast the whole batch. Each row
// can do up to ~5 external calls (2 Admin selling-plan queries, 1 COGS query, 2 GA4 sends), processed
// sequentially → worst-case batch ≈ limit × 5 × per-send timeout. With net.DEFAULT_TIMEOUT_MS = 10s and
// PROCESS_LIMIT = 6 → ≤ ~5 min < this 15-min lease. Keep (limit × 5 × timeout) < LEASE_MINUTES if retuned.
const LEASE_MINUTES = 15;

/**
 * Record a paid order for deferred subscription processing. Called synchronously by orders/paid, so it
 * must be cheap: one encrypted upsert, no network. Idempotent on (shop, order) — a webhook redelivery
 * must NOT reopen a row an earlier pass already closed (update:{} , like recordPendingPurchase).
 * Best-effort. The caller has already gated on serverSide && subscriptionTracking.
 */
export async function recordPendingSubscription(shopDomain, order) {
  const orderId = numericId(order?.id);
  if (!orderId) return;
  await prisma.pendingSubscription
    .upsert({
      where: { shopDomain_orderId: { shopDomain, orderId } },
      create: { shopDomain, orderId, payload: encryptSecret(JSON.stringify(order)), status: "pending" },
      update: {},
    })
    .catch(() => {});
}

/**
 * Process ONE recorded subscription order end-to-end: resolve its selling plans, gate on consent, resolve
 * first-touch attribution, build the subscription_purchase + purchase events (COGS + FX applied), deliver
 * both to GA4, queue any failure to the outbox and stamp GA4 capture. This is the exact pipeline the
 * orders/paid webhook used to run inline — moved here so it no longer blocks the webhook ACK.
 * Returns "sent" | "skipped" | "failed" for the cron summary.
 */
async function processOne(shopDomain, order, settings) {
  if (!settings?.serverSide || !settings?.subscriptionTracking) return "skipped";

  let cfg = {};
  try {
    cfg = JSON.parse(settings.subscriptionConfig || "{}");
  } catch {
    cfg = {};
  }
  const monthDays = Number(cfg.monthDays) || 28;

  // REST orders/paid payloads carry NO selling-plan data, so fetch it from the Admin API and graft it
  // onto the line items — then the pure builders (which read selling_plan_allocation) work as-is.
  const { planByLineId, intervals } = await fetchOrderSubscriptions(shopDomain, order?.id, { monthDays });
  for (const line of order.line_items || []) {
    const plan = planByLineId[String(line.id)];
    if (plan) line.selling_plan_allocation = { selling_plan: { id: plan.id, name: plan.name } };
  }
  // Only subscription orders get server-side conversion events; a non-subscription order's purchase comes
  // from the storefront pixel (firing here would double-count it). If the Admin lookup failed we can't
  // confirm a subscription, so we skip (best-effort) rather than risk a wrong/duplicate send.
  if (!orderHasSubscription(order)) return "skipped";

  // Consent — mirror the pixel's Consent Mode v2. When consentSignals (GCMv2) is on we still send,
  // FLAGGED, so GA4 can model the gap; only strict gating (consentSignals off) hard-drops without consent.
  const respectConsent = cfg.respectConsent !== false;
  const marketingConsent = orderHasAnalyticsConsent(order);
  if (settings.consentMode && respectConsent && !marketingConsent && !settings.consentSignals) return "skipped";
  const consent = settings.consentMode ? { analytics: marketingConsent, marketing: marketingConsent } : undefined;

  // First-touch attribution: the first order for a customer sets the client_id + source; recurring orders
  // inherit it (so they don't look like fresh direct traffic in GA4).
  const cookieClientId = (cfg.clientIdMode === "cookie" && noteAttr(order, "ga_client_id")) || null;
  const key = customerKey(order);
  let attribution = null;
  if (key) {
    const where = { shopDomain_customerKey: { shopDomain, customerKey: key } };
    attribution = await prisma.customerAttribution.findUnique({ where }).catch(() => null);
    if (!attribution) {
      const utms = parseUtms(order);
      attribution =
        (await prisma.customerAttribution
          .create({
            data: {
              shopDomain,
              customerKey: key,
              clientId: cookieClientId,
              source: utms.source,
              medium: utms.medium,
              campaign: utms.campaign,
              firstOrderId: String(order?.id ?? ""),
            },
          })
          .catch(() => null)) || { clientId: cookieClientId, ...utms };
    }
  }

  const clientId = attribution?.clientId || cookieClientId || syntheticClientId(order?.id);
  const attr = attribution ? { source: attribution.source, medium: attribution.medium, campaign: attribution.campaign } : null;
  const opts = { monthDays, clientId, attribution: attr, intervals };
  // Two events per subscription order: the scoped subscription_purchase (subscription lines only) and the
  // regular purchase (whole order). Both server-side so they fire without the pixel/consent.
  const subEvent = buildSubscriptionEvent(order, { eventName: cfg.eventName || "subscription_purchase", ...opts });
  const purchaseEvent = buildOrderPurchaseEvent(order, opts);
  // Value-based optimisation applies to the purchase conversion only. In COGS mode, resolve the order's
  // cost of goods so the purchase value is true profit — same treatment the pixel/reconcile paths get.
  const orderCost = cogsEnabled(settings) ? await resolveOrderCost(shopDomain, orderToTrackingEvent(order)) : undefined;
  withValueMode(purchaseEvent.params, settings.valueMode, settings.marginPct, orderCost);
  // Multi-currency: normalize both events' amounts into the shop's reporting currency (no-op if off).
  await Promise.all([normalizeForShop(settings, subEvent.params), normalizeForShop(settings, purchaseEvent.params)]);

  const [subRes, buyRes] = await Promise.all([sendGa4Event(settings, subEvent, { consent }), sendGa4Event(settings, purchaseEvent, { consent })]);
  // Durable retry: queue either GA4 send that failed so /cron/tick re-sends it (recurring renewals have
  // no pixel fallback, so a lost webhook purchase is a permanent miss otherwise).
  if (!buyRes?.sent && buyRes?.job) await enqueue(shopDomain, buyRes.job, buyRes.detail);
  if (!subRes?.sent && subRes?.job) await enqueue(shopDomain, subRes.job, subRes.detail);
  // Only the `purchase` counts toward Accuracy capture (isPurchase); subscription_purchase is a
  // supplementary custom event and must not double-count.
  await recordDeliveries(shopDomain, [
    { destination: "ga4", eventName: purchaseEvent.name, ok: !!buyRes?.sent, detail: buyRes?.detail || "", isPurchase: true },
    { destination: "ga4", eventName: subEvent.name, ok: !!subRes?.sent, detail: subRes?.detail || "" },
  ]);
  // Stamp GA4 capture for this order so the reconcile pass doesn't re-send the purchase we just delivered
  // server-side (GA4 would dedup it anyway, but this avoids the redundant call).
  if (buyRes?.sent) await recordCapture(shopDomain, order?.id, { ga4: true });
  // A queued-for-retry send isn't lost, but it hasn't reached GA4 yet — report it as failed for the
  // cron summary so a persistent outage is visible (the outbox still owns the eventual delivery).
  return buyRes?.sent || subRes?.sent ? "sent" : "failed";
}

// Map a processOne outcome to the row's terminal status. "skipped" (not a subscription / consent-dropped)
// stays skipped; "sent" and "failed" both close as "done" — a failed send has been queued to the outbox,
// which now owns the retry, so re-running the whole pipeline would duplicate attribution/records.
const statusFor = (outcome) => (outcome === "skipped" ? "skipped" : "done");

async function settleRow(key, outcome, detail) {
  await prisma.pendingSubscription
    .update({ where: key, data: { status: statusFor(outcome), detail: detail || outcome, leaseToken: null, leasedUntil: null } })
    .catch(() => {});
}

/**
 * Claim ONE pending row with a compare-and-swap lease: updateMany with the still-unleased guard, then read
 * the affected count. Postgres row-locks serialize concurrent claims, so exactly one caller gets count === 1
 * — that caller owns the row and may process it; everyone else (an overlapping cron tick, a duplicate kick)
 * gets 0 and backs off. Returns the lease token when claimed, else null. This is what lets the immediate
 * (webhook) path and the cron backstop run against the same row without ever double-sending.
 */
async function claimRow(shopDomain, orderId) {
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  const leasedUntil = new Date(Date.now() + LEASE_MINUTES * 60_000);
  const res = await prisma.pendingSubscription
    .updateMany({
      where: { shopDomain, orderId, status: "pending", OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] },
      data: { leaseToken, leasedUntil },
    })
    .catch(() => ({ count: 0 }));
  return res?.count === 1 ? leaseToken : null;
}

/**
 * Deliver a recorded subscription order IMMEDIATELY (called fire-and-forget by orders/paid, after the row
 * is recorded, so the conversion reaches GA4 in seconds instead of on the next cron tick). It claims the
 * row's lease first, so the /cron/tick backstop can't also process it; if this path dies mid-flight the row
 * stays pending (its lease expires) and the next tick finishes it. NOT awaited by the webhook — it runs
 * after the 200. Best-effort. Returns the outcome (or "busy" when another path already owns the row).
 */
export async function processSubscriptionNow(shopDomain, order, { settings } = {}) {
  const orderId = numericId(order?.id);
  if (!orderId) return "skipped";
  const token = await claimRow(shopDomain, orderId);
  if (!token) return "busy"; // the cron pass (or a duplicate kick) already owns it — don't double-send
  const key = { shopDomain_orderId: { shopDomain, orderId } };
  let outcome = "skipped";
  let detail = "";
  try {
    const s = settings || (await prisma.trackingSettings.findUnique({ where: { shopDomain } }).catch(() => null));
    outcome = await processOne(shopDomain, order, s);
  } catch (e) {
    outcome = "failed";
    detail = (e?.message || "error").slice(0, 200);
  }
  await settleRow(key, outcome, detail);
  return outcome;
}

/**
 * Lease and process a batch of recorded subscription orders (called by /cron/tick as the BACKSTOP for the
 * immediate path above — it only picks up rows whose webhook kick never finished). Same compare-and-swap
 * lease as reconcilePending: two overlapping ticks (or a tick and an in-flight immediate kick) can't claim
 * the same row and double-send. Returns a summary for the cron log.
 */
export async function processPendingSubscriptions({ limit = 6 } = {}) {
  const now = new Date();
  const unleased = [{ leasedUntil: null }, { leasedUntil: { lt: now } }];
  const due = await prisma.pendingSubscription
    .findMany({ where: { status: "pending", OR: unleased }, orderBy: { createdAt: "asc" }, take: limit })
    .catch(() => []);
  if (!due.length) return { processed: 0, sent: 0, skipped: 0, failed: 0 };

  const leaseToken = crypto.randomUUID();
  const leasedUntil = new Date(Date.now() + LEASE_MINUTES * 60_000);
  // Match the EXACT (shop, order) pairs we read (composite key — a naive `orderId in […]` would cross-match
  // another shop's order sharing the id), AND-combined with the still-unleased guard.
  await prisma.pendingSubscription
    .updateMany({
      where: { status: "pending", AND: [{ OR: unleased }, { OR: due.map((r) => ({ shopDomain: r.shopDomain, orderId: r.orderId })) }] },
      data: { leaseToken, leasedUntil },
    })
    .catch(() => {});
  const claimed = await prisma.pendingSubscription.findMany({ where: { leaseToken }, take: limit }).catch(() => []);
  if (!claimed.length) return { processed: 0, sent: 0, skipped: 0, failed: 0 };

  const settingsCache = new Map();
  const getSettings = async (shopDomain) => {
    if (!settingsCache.has(shopDomain)) {
      settingsCache.set(shopDomain, await prisma.trackingSettings.findUnique({ where: { shopDomain } }).catch(() => null));
    }
    return settingsCache.get(shopDomain);
  };

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of claimed) {
    const key = { shopDomain_orderId: { shopDomain: row.shopDomain, orderId: row.orderId } };
    let order = null;
    try {
      order = JSON.parse(decryptSecret(row.payload));
    } catch {
      order = null;
    }
    let outcome = "skipped";
    let detail = "";
    if (!order) {
      detail = "corrupt payload";
    } else {
      const settings = await getSettings(row.shopDomain);
      try {
        outcome = await processOne(row.shopDomain, order, settings);
      } catch (e) {
        outcome = "failed";
        detail = (e?.message || "error").slice(0, 200);
      }
    }
    if (outcome === "sent") sent++;
    else if (outcome === "failed") failed++;
    else skipped++;
    await settleRow(key, outcome, detail);
  }
  return { processed: claimed.length, sent, skipped, failed };
}
