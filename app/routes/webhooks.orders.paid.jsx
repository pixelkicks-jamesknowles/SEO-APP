// orders/paid → send a server-side GA4 `subscription_purchase` event (spec: seo-subscription-tracking-v1).
// HMAC is verified by authenticate.webhook. Idempotent (ProcessedWebhook). Consent-gated. Best-effort:
// always 200 once accepted so Shopify never retries (which would duplicate); GA4 send is fire-and-log.
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildSubscriptionEvent, syntheticClientId, noteAttr, orderHasAnalyticsConsent } from "../lib/subscription";
import { parseUtms, customerKey } from "../lib/attribution";
import { sendGa4Event } from "../lib/server-side.server";
import { bumpDaily } from "../lib/delivery.server";

export const action = async ({ request }) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  try {
    // Count every paid order (Shopify's source of truth) for the Accuracy match-rate, regardless of
    // whether subscription tracking is on.
    await bumpDaily(shop, { ordersPaid: 1 });

    const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain: shop } });
    if (!settings?.serverSide || !settings?.subscriptionTracking) return new Response();

    // Idempotency — dedupe on the Shopify webhook id (fallback: order id).
    const dedupeKey = webhookId || `order:${payload?.id}`;
    const seen = await prisma.processedWebhook.findUnique({ where: { webhookId: dedupeKey } }).catch(() => null);
    if (seen) return new Response();

    let cfg = {};
    try {
      cfg = JSON.parse(settings.subscriptionConfig || "{}");
    } catch {
      cfg = {};
    }

    // Consent gate — respect the merchant's consentMode unless explicitly opted out per shop.
    const respectConsent = cfg.respectConsent !== false;
    if (settings.consentMode && respectConsent && !orderHasAnalyticsConsent(payload)) {
      return new Response();
    }

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
    const event = buildSubscriptionEvent(payload, {
      eventName: cfg.eventName || "subscription_purchase",
      monthDays: Number(cfg.monthDays) || 28,
      clientId,
      attribution: attribution
        ? { source: attribution.source, medium: attribution.medium, campaign: attribution.campaign }
        : null,
    });

    await sendGa4Event(settings, event);
    await prisma.processedWebhook
      .create({ data: { webhookId: dedupeKey, shopDomain: shop, topic: "orders/paid" } })
      .catch(() => {}); // a race just means we already sent once
  } catch (e) {
    console.warn("[orders/paid] subscription tracking:", e?.message || e);
  }
  return new Response();
};
