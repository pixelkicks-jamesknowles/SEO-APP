// Proactive health alerting. The app already evaluates a shop's tracking health into ranked alerts
// (health.js) and shows them as in-app banners — but a merchant only sees those if they open the app.
// This pushes the SAME alerts to an incoming webhook (Slack / Discord / Teams / generic) from the cron,
// so a broken pixel, a dead-lettered conversion or a capture-rate drop reaches them where they work.
//
// Deduped per (shop, alert kind) on a cooldown so a still-firing condition doesn't spam every tick, and
// re-armed when a condition clears (a recurrence alerts again immediately). Best-effort throughout.
import prisma from "../db.server";
import { fetchWithTimeout } from "./net.server";
import { computeHealth } from "./health.server";

// Re-notify a still-firing alert at most once per this window.
export const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const EMOJI = { critical: ":rotating_light:", warning: ":warning:" };

// Teams via Power Automate / Logic Apps ("Workflows" app) — the modern replacement for the O365 connector.
// Its "when a webhook request is received" trigger expects an ADAPTIVE CARD envelope, not a {text} field:
// a bare {text} POST is accepted (202) but renders nothing, so the message never appears. Detect these hosts.
function isTeamsWorkflow(host) {
  return /(^|\.)(powerplatform\.com|powerautomate\.com|logic\.azure\.com|azure-api\.net)$/.test(host) || host.includes("powerplatform");
}

// Adaptive Card message envelope for Teams Workflows / Logic Apps.
function teamsAdaptiveCard(shopDomain, alerts) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", size: "Medium", weight: "Bolder", text: `Connect Analytics — ${shopDomain}` },
            ...alerts.map((a) => ({ type: "TextBlock", wrap: true, text: `**${a.title}**\n\n${a.body}` })),
          ],
        },
      },
    ],
  };
}

/** Build an incoming-webhook payload for a set of alerts, SHAPED FOR THE TARGET (detected from the URL):
 *  Teams Workflows / Logic Apps → Adaptive Card; legacy Teams O365 connector → MessageCard; Slack, Discord
 *  and generic → both `text` (Slack) and `content` (Discord) in one body. Pure; url is optional (no url →
 *  the generic Slack/Discord shape, preserving old behaviour). */
export function buildAlertPayload(shopDomain, alerts, url = "") {
  const lines = alerts.map((a) => `${EMOJI[a.severity] || "•"} *${a.title}*\n${a.body}`);
  const text = `*Connect Analytics* — ${shopDomain}\n\n${lines.join("\n\n")}`;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (host && isTeamsWorkflow(host)) return teamsAdaptiveCard(shopDomain, alerts);
  // Legacy Teams "Incoming Webhook" O365 connector (outlook.office.com / *.webhook.office.com) → MessageCard.
  if (host.endsWith("office.com") || host.includes("webhook.office")) {
    return { "@type": "MessageCard", "@context": "https://schema.org/extensions", summary: "Connect Analytics alert", text };
  }
  return { text, content: text };
}

/** POST a payload to a webhook URL. Best-effort → { ok, detail }. */
export async function postAlertWebhook(url, payload) {
  try {
    const res = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return { ok: res.ok, detail: String(res.status) };
  } catch (e) {
    return { ok: false, detail: e?.name === "AbortError" ? "timeout" : e?.message || "network error" };
  }
}

/**
 * Notify a shop's webhook of its firing health alerts. Re-arms cleared kinds (so a recurrence alerts
 * again), then sends only the kinds not already notified within the cooldown. Returns { notified }.
 */
export async function notifyHealth(shopDomain, settings, health) {
  const url = settings?.alertWebhookUrl;
  if (!url) return { notified: 0 };
  const firing = health?.alerts || [];
  const firingKinds = firing.map((a) => a.kind);
  // Re-arm: drop notify records for kinds no longer firing so the same problem, if it returns, alerts
  // immediately rather than being suppressed by a stale cooldown.
  await prisma.alertNotification.deleteMany({ where: { shopDomain, kind: { notIn: firingKinds } } }).catch(() => {});
  if (!firing.length) return { notified: 0 };

  const existing = await prisma.alertNotification.findMany({ where: { shopDomain, kind: { in: firingKinds } } }).catch(() => []);
  const onCooldown = new Set(existing.filter((r) => Date.now() - new Date(r.notifiedAt).getTime() < ALERT_COOLDOWN_MS).map((r) => r.kind));
  const toSend = firing.filter((a) => !onCooldown.has(a.kind));
  if (!toSend.length) return { notified: 0 };

  const r = await postAlertWebhook(url, buildAlertPayload(shopDomain, toSend, url));
  if (!r.ok) return { notified: 0, error: r.detail };
  await Promise.all(
    toSend.map((a) =>
      prisma.alertNotification
        .upsert({ where: { shopDomain_kind: { shopDomain, kind: a.kind } }, create: { shopDomain, kind: a.kind }, update: { notifiedAt: new Date() } })
        .catch(() => {}),
    ),
  );
  return { notified: toSend.length };
}

/** Cron pass: for every shop with an alert webhook configured, compute health + notify. Returns a summary. */
export async function runAlerts({ limit = 500 } = {}) {
  const shops = await prisma.trackingSettings.findMany({ where: { alertWebhookUrl: { not: null } }, take: limit }).catch(() => []);
  let notified = 0;
  for (const settings of shops) {
    const health = await computeHealth(settings.shopDomain).catch(() => null);
    if (health) notified += (await notifyHealth(settings.shopDomain, settings, health)).notified || 0;
  }
  return { shops: shops.length, notified };
}
