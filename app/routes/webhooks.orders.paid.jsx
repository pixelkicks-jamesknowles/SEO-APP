// orders/paid → send a server-side GA4 `subscription_purchase` event (spec: seo-subscription-tracking-v1).
// HMAC is verified by authenticate.webhook. Idempotent (ProcessedWebhook). Consent-gated. Best-effort:
// always 200 once accepted so Shopify never retries (which would duplicate); GA4 send is fire-and-log.
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildSubscriptionEvent, buildOrderPurchaseEvent, orderHasSubscription, syntheticClientId, noteAttr, orderHasAnalyticsConsent } from "../lib/subscription";
import { fetchOrderSubscriptions } from "../lib/subscription.server";
import { parseUtms, customerKey } from "../lib/attribution";
import { sendGa4Event, withValueMode } from "../lib/server-side.server";
import { bumpDaily, recordDeliveries } from "../lib/delivery.server";
import { enqueue } from "../lib/outbox.server";
import { normalizeForShop } from "../lib/fx.server";
import { recordPendingPurchase, recordCapture, orderToTrackingEvent } from "../lib/reconcile.server";
import { cogsEnabled, resolveOrderCost } from "../lib/cogs.server";

export const action = async ({ request }) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  try {
    // Idempotency FIRST — Shopify can deliver a webhook more than once. This gate guards BOTH the
    // ordersPaid counter (below) and the subscription send; without it, a redelivery double-counts
    // ordersPaid and silently depresses the Accuracy match-rate denominator.
    const dedupeKey = webhookId || `order:${payload?.id}`;
    const seen = await prisma.processedWebhook.findUnique({ where: { webhookId: dedupeKey } }).catch(() => null);
    if (seen) return new Response();
    // Mark processed up front so a retry is a clean no-op. Best-effort (like the whole webhook): we
    // always 200 so Shopify never retries, so there's no send worth un-marking on a later failure.
    await prisma.processedWebhook
      .create({ data: { webhookId: dedupeKey, shopDomain: shop, topic: "orders/paid" } })
      .catch(() => {}); // a race just means another delivery already claimed it

    // Count every paid order (Shopify's source of truth) for the Accuracy match-rate, regardless of
    // whether subscription tracking is on.
    await bumpDaily(shop, { ordersPaid: 1 });

    const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain: shop } });

    // Reconciliation: record EVERY paid order so a delayed cron pass can backfill the GA4/Meta purchase
    // if the storefront pixel never delivered it. Safe for subscription orders too (GA4 dedups on order
    // id; the subscription branch below stamps GA4 capture so reconcile skips the redundant send).
    await recordPendingPurchase(shop, payload, settings);

    if (!settings?.serverSide || !settings?.subscriptionTracking) return new Response();

    let cfg = {};
    try {
      cfg = JSON.parse(settings.subscriptionConfig || "{}");
    } catch {
      cfg = {};
    }
    const monthDays = Number(cfg.monthDays) || 28;

    // REST orders/paid payloads carry NO selling-plan data, so fetch it from the Admin API and graft
    // it onto the line items — then the pure builders (which read selling_plan_allocation) work as-is.
    const { planByLineId, intervals } = await fetchOrderSubscriptions(shop, payload?.id, { monthDays });
    for (const line of payload.line_items || []) {
      const plan = planByLineId[String(line.id)];
      if (plan) line.selling_plan_allocation = { selling_plan: { id: plan.id, name: plan.name } };
    }
    // Only subscription orders get server-side conversion events; a non-subscription order's purchase
    // comes from the storefront pixel (firing here would double-count it). If the Admin lookup failed
    // we can't confirm a subscription, so we skip (best-effort) rather than risk a wrong/duplicate send.
    if (!orderHasSubscription(payload)) return new Response();

    // Consent — mirror the pixel's Consent Mode v2. When consentSignals (GCMv2) is on we still send,
    // FLAGGED, so GA4 can model the gap; only strict gating (consentSignals off) hard-drops without
    // consent. buyer_accepts_marketing is the email opt-in (not the storefront cookie consent), so
    // it's a coarse signal — GCMv2 flagging is what avoids silently dropping subscription conversions.
    const respectConsent = cfg.respectConsent !== false;
    const marketingConsent = orderHasAnalyticsConsent(payload);
    if (settings.consentMode && respectConsent && !marketingConsent && !settings.consentSignals) {
      return new Response();
    }
    const consent = settings.consentMode ? { analytics: marketingConsent, marketing: marketingConsent } : undefined;

    // First-touch attribution: the first order for a customer sets the client_id + source; recurring
    // orders inherit it (so they don't look like fresh direct traffic in GA4).
    const cookieClientId = (cfg.clientIdMode === "cookie" && noteAttr(payload, "ga_client_id")) || null;
    const key = customerKey(payload);
    let attribution = null;
    if (key) {
      const where = { shopDomain_customerKey: { shopDomain: shop, customerKey: key } };
      attribution = await prisma.customerAttribution.findUnique({ where }).catch(() => null);
      if (!attribution) {
        const utms = parseUtms(payload);
        attribution =
          (await prisma.customerAttribution
            .create({
              data: {
                shopDomain: shop,
                customerKey: key,
                clientId: cookieClientId,
                source: utms.source,
                medium: utms.medium,
                campaign: utms.campaign,
                firstOrderId: String(payload?.id ?? ""),
              },
            })
            .catch(() => null)) || { clientId: cookieClientId, ...utms };
      }
    }

    const clientId = attribution?.clientId || cookieClientId || syntheticClientId(payload?.id);
    const attr = attribution
      ? { source: attribution.source, medium: attribution.medium, campaign: attribution.campaign }
      : null;
    const opts = { monthDays, clientId, attribution: attr, intervals };
    // Two events per subscription order: the scoped subscription_purchase (subscription lines only)
    // and the regular purchase (whole order). Both server-side so they fire without the pixel/consent.
    const subEvent = buildSubscriptionEvent(payload, { eventName: cfg.eventName || "subscription_purchase", ...opts });
    const purchaseEvent = buildOrderPurchaseEvent(payload, opts);
    // Value-based optimisation applies to the purchase conversion only (subscription_purchase keeps its
    // raw discounted amount for the SEO team's revenue report). In COGS mode, resolve the order's cost of
    // goods so the purchase value is true profit — same treatment the pixel/reconcile paths get.
    const orderCost = cogsEnabled(settings) ? await resolveOrderCost(shop, orderToTrackingEvent(payload)) : undefined;
    withValueMode(purchaseEvent.params, settings.valueMode, settings.marginPct, orderCost);
    // Multi-currency: normalize both events' amounts into the shop's reporting currency (no-op if off).
    await Promise.all([normalizeForShop(settings, subEvent.params), normalizeForShop(settings, purchaseEvent.params)]);

    const [subRes, buyRes] = await Promise.all([
      sendGa4Event(settings, subEvent, { consent }),
      sendGa4Event(settings, purchaseEvent, { consent }),
    ]);
    // Durable retry: queue either GA4 send that failed so /cron/tick re-sends it (recurring renewals
    // have no pixel fallback, so a lost webhook purchase is a permanent miss otherwise).
    if (!buyRes?.sent && buyRes?.job) await enqueue(shop, buyRes.job, buyRes.detail);
    if (!subRes?.sent && subRes?.job) await enqueue(shop, subRes.job, subRes.detail);
    // Only the `purchase` counts toward Accuracy capture (isPurchase); subscription_purchase is a
    // supplementary custom event and must not double-count. NOTE: an *initial* subscription order also
    // fires the pixel's checkout_completed (Meta/GTM), which recordDeliveries counts too — so match
    // can exceed 100% for that one order. Recurring renewals have no checkout, so this webhook purchase
    // is their only capture signal. Dedupe per order id vs the pixel event if this becomes material.
    await recordDeliveries(shop, [
      { destination: "ga4", eventName: purchaseEvent.name, ok: !!buyRes?.sent, detail: buyRes?.detail || "", isPurchase: true },
      { destination: "ga4", eventName: subEvent.name, ok: !!subRes?.sent, detail: subRes?.detail || "" },
    ]);
    // Stamp GA4 capture for this order so the reconcile pass doesn't re-send the purchase we just
    // delivered server-side (GA4 would dedup it anyway, but this avoids the redundant call).
    if (buyRes?.sent) await recordCapture(shop, payload?.id, { ga4: true });
  } catch (e) {
    console.warn("[orders/paid] subscription tracking:", e?.message || e);
  }
  return new Response();
};
