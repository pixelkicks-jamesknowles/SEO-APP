/* eslint-disable import/first -- jest.mock() must precede the imports it intercepts */
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { buildAlertPayload, postAlertWebhook, notifyHealth, runAlerts, ALERT_COOLDOWN_MS } from "../app/lib/alerting.server.js";

const SHOP = "s.myshopify.com";
const alert = (kind, severity = "warning") => ({ kind, severity, title: `${kind} title`, body: `${kind} body` });

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
});
afterEach(() => (global.fetch = undefined));

describe("buildAlertPayload", () => {
  test("names the shop and includes each alert's title + body, in both text and content", () => {
    const p = buildAlertPayload(SHOP, [alert("outbox_dead", "critical")]);
    expect(p.text).toContain(SHOP);
    expect(p.text).toContain("outbox_dead title");
    expect(p.text).toContain("outbox_dead body");
    expect(p.content).toBe(p.text); // Discord-compatible
  });

  test("Slack/Discord/generic shape when no URL or an unknown host", () => {
    const p = buildAlertPayload(SHOP, [alert("x", "warning")], "https://hooks.slack.com/services/T/B/x");
    expect(p.text).toBeDefined();
    expect(p.content).toBe(p.text);
    expect(p.attachments).toBeUndefined();
  });

  test("Teams Power Automate / Workflows URL → Adaptive Card envelope, not {text}", () => {
    const url = "https://defaultabc.de.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/06/workflows/x/triggers/manual/paths/invoke?api-version=1&sig=abc";
    const p = buildAlertPayload(SHOP, [alert("outbox_dead", "critical")], url);
    expect(p.type).toBe("message");
    expect(p.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    const card = p.attachments[0].content;
    expect(card.type).toBe("AdaptiveCard");
    // the alert title/body must be somewhere in the card body text blocks
    const blob = JSON.stringify(card.body);
    expect(blob).toContain("outbox_dead title");
    expect(blob).toContain("outbox_dead body");
    expect(p.text).toBeUndefined(); // Teams Workflows ignores {text}; must be a card
  });

  test("Logic Apps host is also treated as Teams Workflows", () => {
    const p = buildAlertPayload(SHOP, [alert("x", "warning")], "https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x");
    expect(p.type).toBe("message");
  });

  test("legacy Teams O365 connector host → MessageCard", () => {
    const p = buildAlertPayload(SHOP, [alert("x", "warning")], "https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def");
    expect(p["@type"]).toBe("MessageCard");
    expect(p.text).toContain(SHOP);
  });
});

describe("postAlertWebhook", () => {
  test("a network error is caught → { ok:false }", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("boom"));
    expect(await postAlertWebhook("https://hook", {})).toMatchObject({ ok: false });
  });
});

describe("notifyHealth", () => {
  test("no webhook configured → sends nothing", async () => {
    const r = await notifyHealth(SHOP, { alertWebhookUrl: null }, { alerts: [alert("outbox_dead")] });
    expect(r.notified).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("posts firing alerts not on cooldown, and records the notification", async () => {
    prisma.alertNotification.findMany.mockResolvedValue([]); // nothing notified before
    const r = await notifyHealth(SHOP, { alertWebhookUrl: "https://hook" }, { alerts: [alert("outbox_dead", "critical"), alert("capture_low")] });
    expect(r.notified).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(1); // one batched post
    expect(prisma.alertNotification.upsert).toHaveBeenCalledTimes(2);
  });

  test("an alert notified within the cooldown is suppressed", async () => {
    prisma.alertNotification.findMany.mockResolvedValue([{ kind: "outbox_dead", notifiedAt: new Date() }]);
    const r = await notifyHealth(SHOP, { alertWebhookUrl: "https://hook" }, { alerts: [alert("outbox_dead")] });
    expect(r.notified).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("an alert whose cooldown has lapsed is re-sent", async () => {
    prisma.alertNotification.findMany.mockResolvedValue([{ kind: "outbox_dead", notifiedAt: new Date(Date.now() - ALERT_COOLDOWN_MS - 1000) }]);
    const r = await notifyHealth(SHOP, { alertWebhookUrl: "https://hook" }, { alerts: [alert("outbox_dead")] });
    expect(r.notified).toBe(1);
  });

  test("re-arms: notify records for kinds no longer firing are cleared", async () => {
    prisma.alertNotification.findMany.mockResolvedValue([]);
    await notifyHealth(SHOP, { alertWebhookUrl: "https://hook" }, { alerts: [alert("capture_low")] });
    // deleteMany called with the firing set so stale kinds (e.g. a cleared outbox_dead) are dropped.
    expect(prisma.alertNotification.deleteMany).toHaveBeenCalledWith({ where: { shopDomain: SHOP, kind: { notIn: ["capture_low"] } } });
  });

  test("a failed webhook post does not record a notification (so it retries next tick)", async () => {
    prisma.alertNotification.findMany.mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const r = await notifyHealth(SHOP, { alertWebhookUrl: "https://hook" }, { alerts: [alert("outbox_dead")] });
    expect(r.notified).toBe(0);
    expect(prisma.alertNotification.upsert).not.toHaveBeenCalled();
  });
});

describe("runAlerts", () => {
  test("iterates the shops with a webhook configured and returns a summary", async () => {
    prisma.trackingSettings.findMany.mockResolvedValue([{ shopDomain: SHOP, alertWebhookUrl: "https://hook" }]);
    // computeHealth reads empty daily/outbox data from the mock → no alerts → nothing to notify.
    const r = await runAlerts();
    expect(r.shops).toBe(1);
    expect(r.notified).toBe(0);
  });

  test("no shops configured → clean no-op", async () => {
    prisma.trackingSettings.findMany.mockResolvedValue([]);
    expect(await runAlerts()).toEqual({ shops: 0, notified: 0 });
  });
});
