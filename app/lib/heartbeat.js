// Pure worker-liveness math (no IO — unit-tested). The background worker (/cron/tick) stamps a heartbeat
// each run; this turns "how long since the last tick" into a staleness verdict for the dashboard tile and
// the cron_stale health alert. See heartbeat.server.js (persistence) + health.js (alert emission).

// Minutes since the last tick before the dashboard flags the worker as lagging (warning).
export const CRON_STALE_MIN = 15;
// Minutes since the last tick before the worker is considered stopped (critical). A missed cron, an unset
// CRON_SECRET, or a crashed Railway service all land here — everything deferred (retries, reconciliation,
// subscription conversions) has silently stalled.
export const CRON_ALERT_MIN = 45;

/** Whole minutes between `date` and `now`. A missing/invalid date → Infinity ("never" / unknowable). */
export function minutesSince(date, now = Date.now()) {
  if (!date) return Infinity;
  const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, Math.round((now - t) / 60000));
}

/** True once the last tick is at least `thresholdMin` old. */
export function isStale(lastTickAt, now = Date.now(), thresholdMin = CRON_STALE_MIN) {
  return minutesSince(lastTickAt, now) >= thresholdMin;
}

/** null (healthy) | "warning" (lagging) | "critical" (stopped), by how many minutes stale. */
export function staleSeverity(minutesStale, { staleMin = CRON_STALE_MIN, alertMin = CRON_ALERT_MIN } = {}) {
  if (!(minutesStale >= 0)) return null; // guards null/NaN (never treat "unknown" as an alert here)
  if (minutesStale >= alertMin) return "critical";
  if (minutesStale >= staleMin) return "warning";
  return null;
}

/**
 * The health alert for a stale/stopped worker, or null when healthy. `cronStaleMinutes` must be a number
 * (minutes since last tick); callers pass `null` when the worker has NEVER run (fresh install) so we don't
 * alarm before the cron's first tick — that case is surfaced as an info state on the dashboard tile instead.
 */
export function cronStaleAlert(cronStaleMinutes, opts = {}) {
  if (cronStaleMinutes == null) return null;
  const severity = staleSeverity(cronStaleMinutes, opts);
  if (!severity) return null;
  const title =
    severity === "critical"
      ? `Background worker hasn't run for ${cronStaleMinutes} minutes — tracking may have stalled`
      : `Background worker last ran ${cronStaleMinutes} minutes ago`;
  return {
    kind: "cron_stale",
    severity,
    title,
    body: "The scheduled worker (/cron/tick) drives delivery retries, purchase reconciliation and subscription conversions. If it's stopped, those silently stall. Check the cron service and CRON_SECRET — see the deploy runbook.",
  };
}
