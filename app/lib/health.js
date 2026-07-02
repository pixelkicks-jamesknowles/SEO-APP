// Pure delivery-health evaluation (no IO — unit-tested). Turns a shop's reconciliation metrics into a
// ranked list of actionable alerts for the in-app banners on Home + Accuracy. computeHealth (health.
// server.js) gathers the metrics from the DB and calls this.

export const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

// Thresholds (exported so the UI copy + tests reference one source of truth).
export const CAPTURE_MIN = 90; // % of paid orders captured as purchase events
export const DELIVERY_MIN = 98; // % of server-side sends that succeeded
export const OUTBOX_BACKLOG_MAX = 25; // pending retries before it's worth flagging

/**
 * metrics: {
 *   ordersPaid30, purchasesDelivered30, eventsSent30, eventsFailed30,  // 30-day totals
 *   ordersPaid24, purchasesDelivered24,                                 // last-24h totals
 *   outboxPending, outboxDead,                                          // retry queue
 * }
 * Returns { captureRate, deliveryRate, outboxPending, outboxDead, alerts: [{ kind, severity, title, body }] }.
 * Alerts are ordered most-severe first.
 */
export function evaluateHealth(metrics = {}) {
  const m = metrics;
  const captureRate = pct(m.purchasesDelivered30 || 0, m.ordersPaid30 || 0);
  const sends = (m.eventsSent30 || 0) + (m.eventsFailed30 || 0);
  const deliveryRate = pct(m.eventsSent30 || 0, sends);
  const alerts = [];

  // Critical: dead-lettered sends are conversions we will never deliver without action.
  if ((m.outboxDead || 0) > 0) {
    alerts.push({
      kind: "outbox_dead",
      severity: "critical",
      title: `${m.outboxDead} event${m.outboxDead > 1 ? "s" : ""} could not be delivered after retries`,
      body: "These exhausted their retries. Check the destination credentials on Settings — new events will keep failing the same way until it's fixed.",
    });
  }
  // Critical: paid orders in the last day but nothing captured → the pixel/webhook likely stopped.
  if ((m.ordersPaid24 || 0) > 0 && (m.purchasesDelivered24 || 0) === 0) {
    alerts.push({
      kind: "no_captures",
      severity: "critical",
      title: "Paid orders in the last 24h but no purchase events delivered",
      body: "Server-side delivery may be off, the pixel may not be firing at checkout, or the GA4 secret may be wrong. Open Accuracy and Settings to check.",
    });
  }
  // Warning: capture rate below target (usually consent declines or the pixel missing some checkouts).
  if (captureRate != null && captureRate < CAPTURE_MIN) {
    alerts.push({
      kind: "capture_low",
      severity: "warning",
      title: `Only ${captureRate}% of paid orders captured as purchase events (30d)`,
      body: "The gap is usually visitors who declined consent, or the pixel not firing on some checkouts. Compare with GA4 and review Consent settings on Tracking.",
    });
  }
  // Warning: delivery success below target → a destination is intermittently rejecting sends.
  if (deliveryRate != null && deliveryRate < DELIVERY_MIN) {
    alerts.push({
      kind: "delivery_low",
      severity: "warning",
      title: `Server-side delivery success is ${deliveryRate}% (30d)`,
      body: "A destination is rejecting or timing out on some sends. Failed sends are retried automatically — check Delivery health for the failing destination.",
    });
  }
  // Warning: retries piling up faster than they drain.
  if ((m.outboxPending || 0) > OUTBOX_BACKLOG_MAX) {
    alerts.push({
      kind: "outbox_backlog",
      severity: "warning",
      title: `${m.outboxPending} events are queued for retry`,
      body: "A destination has been failing recently. They'll keep retrying with backoff; if the backlog grows, verify the destination's credentials.",
    });
  }

  return { captureRate, deliveryRate, outboxPending: m.outboxPending || 0, outboxDead: m.outboxDead || 0, alerts };
}
