import { evaluateHealth, CAPTURE_MIN, DELIVERY_MIN, OUTBOX_BACKLOG_MAX } from "../app/lib/health.js";
import { CRON_STALE_MIN, CRON_ALERT_MIN } from "../app/lib/heartbeat.js";

const kinds = (h) => h.alerts.map((a) => a.kind);

describe("evaluateHealth", () => {
  test("healthy metrics produce no alerts", () => {
    const h = evaluateHealth({
      ordersPaid30: 100, purchasesDelivered30: 98, eventsSent30: 1000, eventsFailed30: 5,
      ordersPaid24: 5, purchasesDelivered24: 5, outboxPending: 0, outboxDead: 0,
    });
    expect(h.alerts).toHaveLength(0);
    expect(h.captureRate).toBe(98);
  });

  test("low capture rate warns", () => {
    const h = evaluateHealth({ ordersPaid30: 100, purchasesDelivered30: 50, eventsSent30: 100, eventsFailed30: 0, ordersPaid24: 0, purchasesDelivered24: 0 });
    expect(kinds(h)).toContain("capture_low");
    expect(h.captureRate).toBeLessThan(CAPTURE_MIN);
  });

  test("low delivery rate warns", () => {
    const h = evaluateHealth({ ordersPaid30: 10, purchasesDelivered30: 10, eventsSent30: 80, eventsFailed30: 20, ordersPaid24: 0, purchasesDelivered24: 0 });
    expect(kinds(h)).toContain("delivery_low");
    expect(h.deliveryRate).toBeLessThan(DELIVERY_MIN);
  });

  test("dead-lettered sends are critical and ranked first", () => {
    const h = evaluateHealth({ ordersPaid30: 10, purchasesDelivered30: 5, eventsSent30: 10, eventsFailed30: 0, outboxDead: 3 });
    expect(h.alerts[0].kind).toBe("outbox_dead");
    expect(h.alerts[0].severity).toBe("critical");
  });

  test("paid orders but no captures in 24h is critical", () => {
    const h = evaluateHealth({ ordersPaid30: 10, purchasesDelivered30: 10, eventsSent30: 10, eventsFailed30: 0, ordersPaid24: 3, purchasesDelivered24: 0 });
    expect(kinds(h)).toContain("no_captures");
  });

  test("outbox backlog over the threshold warns", () => {
    const h = evaluateHealth({ ordersPaid30: 10, purchasesDelivered30: 10, eventsSent30: 10, eventsFailed30: 0, outboxPending: OUTBOX_BACKLOG_MAX + 1 });
    expect(kinds(h)).toContain("outbox_backlog");
  });

  test("no orders/sends yet → null rates, no alerts", () => {
    const h = evaluateHealth({});
    expect(h.captureRate).toBeNull();
    expect(h.deliveryRate).toBeNull();
    expect(h.alerts).toHaveLength(0);
  });

  test("a stopped worker is critical and ranked first", () => {
    const h = evaluateHealth({ ordersPaid30: 10, purchasesDelivered30: 10, eventsSent30: 10, eventsFailed30: 0, cronStaleMinutes: CRON_ALERT_MIN + 5 });
    expect(h.alerts[0].kind).toBe("cron_stale");
    expect(h.alerts[0].severity).toBe("critical");
  });

  test("a lagging worker warns", () => {
    const h = evaluateHealth({ cronStaleMinutes: CRON_STALE_MIN + 1 });
    expect(kinds(h)).toContain("cron_stale");
    expect(h.alerts.find((a) => a.kind === "cron_stale").severity).toBe("warning");
  });

  test("worker never run (null) → no cron_stale alarm", () => {
    const h = evaluateHealth({ cronStaleMinutes: null });
    expect(kinds(h)).not.toContain("cron_stale");
  });
});
