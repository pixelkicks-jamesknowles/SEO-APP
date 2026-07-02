// Gather a shop's delivery-health metrics from the DB and evaluate them into in-app alerts. Used by
// the Home + Accuracy loaders. Dismissed alerts (AlertDismissal) are suppressed for a re-arm window so
// a merchant can silence a banner but a still-broken thing resurfaces later.
import prisma from "../db.server";
import { evaluateHealth } from "./health";

const REARM_DAYS = 7; // a dismissed alert reappears after this if the condition still holds
const dateStr = (d) => d.toISOString().slice(0, 10);

export async function computeHealth(shopDomain) {
  const since30 = dateStr(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const since24 = dateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const [rows30, rows24, outboxPending, outboxDead, dismissals] = await Promise.all([
    prisma.trackingDaily.findMany({ where: { shopDomain, date: { gte: since30 } } }).catch(() => []),
    prisma.trackingDaily.findMany({ where: { shopDomain, date: { gte: since24 } } }).catch(() => []),
    prisma.deliveryOutbox.count({ where: { shopDomain, status: "pending" } }).catch(() => 0),
    prisma.deliveryOutbox.count({ where: { shopDomain, status: "dead", updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }).catch(() => 0),
    prisma.alertDismissal.findMany({ where: { shopDomain } }).catch(() => []),
  ]);

  const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
  const metrics = {
    ordersPaid30: sum(rows30, "ordersPaid"),
    purchasesDelivered30: sum(rows30, "purchasesDelivered"),
    eventsSent30: sum(rows30, "eventsSent"),
    eventsFailed30: sum(rows30, "eventsFailed"),
    ordersPaid24: sum(rows24, "ordersPaid"),
    purchasesDelivered24: sum(rows24, "purchasesDelivered"),
    outboxPending,
    outboxDead,
  };

  const health = evaluateHealth(metrics);
  // Drop alerts the merchant dismissed within the re-arm window.
  const rearmBefore = Date.now() - REARM_DAYS * 24 * 60 * 60 * 1000;
  const dismissedKinds = new Set(dismissals.filter((d) => d.dismissedAt.getTime() > rearmBefore).map((d) => d.kind));
  health.alerts = health.alerts.filter((a) => !dismissedKinds.has(a.kind));
  return health;
}

/** Persist a merchant dismissing a health banner (re-armed after REARM_DAYS). Best-effort. */
export async function dismissAlert(shopDomain, kind) {
  if (!shopDomain || !kind) return;
  await prisma.alertDismissal
    .upsert({
      where: { shopDomain_kind: { shopDomain, kind } },
      create: { shopDomain, kind },
      update: { dismissedAt: new Date() },
    })
    .catch(() => {});
}
