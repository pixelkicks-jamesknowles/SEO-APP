import { minutesSince, isStale, staleSeverity, cronStaleAlert, CRON_STALE_MIN, CRON_ALERT_MIN } from "../app/lib/heartbeat.js";

const NOW = new Date("2026-07-05T12:00:00Z").getTime();
const minsAgo = (m) => new Date(NOW - m * 60000);

describe("minutesSince", () => {
  test("counts whole minutes since a past date", () => {
    expect(minutesSince(minsAgo(30), NOW)).toBe(30);
  });
  test("a future date clamps to 0 (clock skew)", () => {
    expect(minutesSince(new Date(NOW + 5 * 60000), NOW)).toBe(0);
  });
  test("null / invalid → Infinity (never / unknowable)", () => {
    expect(minutesSince(null, NOW)).toBe(Infinity);
    expect(minutesSince("not-a-date", NOW)).toBe(Infinity);
  });
  test("accepts an ISO string", () => {
    expect(minutesSince(minsAgo(10).toISOString(), NOW)).toBe(10);
  });
});

describe("isStale", () => {
  test("fresh tick is not stale", () => {
    expect(isStale(minsAgo(2), NOW)).toBe(false);
  });
  test("becomes stale exactly at the threshold", () => {
    expect(isStale(minsAgo(CRON_STALE_MIN - 1), NOW)).toBe(false);
    expect(isStale(minsAgo(CRON_STALE_MIN), NOW)).toBe(true);
  });
});

describe("staleSeverity", () => {
  test("healthy below the stale threshold", () => {
    expect(staleSeverity(CRON_STALE_MIN - 1)).toBeNull();
  });
  test("warning between stale and alert thresholds", () => {
    expect(staleSeverity(CRON_STALE_MIN)).toBe("warning");
    expect(staleSeverity(CRON_ALERT_MIN - 1)).toBe("warning");
  });
  test("critical at/above the alert threshold", () => {
    expect(staleSeverity(CRON_ALERT_MIN)).toBe("critical");
    expect(staleSeverity(Infinity)).toBe("critical");
  });
  test("null/NaN never counts as an alert", () => {
    expect(staleSeverity(null)).toBeNull();
    expect(staleSeverity(NaN)).toBeNull();
  });
});

describe("cronStaleAlert", () => {
  test("null minutes (never run) → no alert (don't alarm fresh installs)", () => {
    expect(cronStaleAlert(null)).toBeNull();
  });
  test("healthy → no alert", () => {
    expect(cronStaleAlert(3)).toBeNull();
  });
  test("lagging → warning cron_stale alert", () => {
    const a = cronStaleAlert(CRON_STALE_MIN + 1);
    expect(a.kind).toBe("cron_stale");
    expect(a.severity).toBe("warning");
  });
  test("stopped → critical cron_stale alert", () => {
    const a = cronStaleAlert(CRON_ALERT_MIN + 100);
    expect(a.kind).toBe("cron_stale");
    expect(a.severity).toBe("critical");
    expect(a.title).toContain("stalled");
  });
});
