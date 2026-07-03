# pixelify-seo → Pixel Kicks Tracking

> **Free, tracking-only app.** The SEO half (meta/schema, audit, CWV, GSC, redirects, sitemap/robots/
> llms, the `seo-schema` extension, plan tiers) was stripped back and **archived** on the
> `archive/seo-full-featured` branch — restore from there if/when it's wanted again. The directory is
> still named `pixelify-seo` for now; the Shopify-facing app name is **Pixel Kicks Tracking**.

Conversion & event tracking for any Shopify store — client-side (Web Pixels) **and** server-side
(GA4 Measurement Protocol / Meta CAPI), including the subscription-purchase event.

## What it does
- **Client-side tracking** — GTM / GA4 / Meta / TikTok / Pinterest / Snap / Bing via the Web Pixel
  extension, with a per-platform event matrix, **consent-gated** through the Customer Privacy API.
- **Server-side tracking** — GA4 Measurement Protocol + Meta CAPI + **TikTok Events API** + **Pinterest
  Conversions API** + **Snapchat Conversions API** + **Reddit Conversions API** + **LinkedIn Conversions
  API** + **Microsoft UET (Bing) Conversions API** + **Klaviyo Events API** (onsite browse/abandonment
  events) + server-side GTM fan-out from the `/track` beacon (`app/lib/server-side.server.js`),
  matrix-gated per destination.
- **Durable first-party id** — the app proxy sets an ITP-proof first-party cookie (`pxp_id`) via a
  server `Set-Cookie` (not capped by Safari's 7-day script-cookie rule); the pixel + embed both carry it
  as a stable `client_id`, so a returning visitor is ONE user across sessions even after `_ga` expires
  (`app/lib/durable-id.server.js`). Requires the SEO-engagement theme embed (it mints the cookie).
- **Identity stitching** — a graph links the durable id ↔ GA4 client id ↔ customer, so a conversion
  inherits its visitor's original first-touch across sessions/devices instead of looking direct
  (`app/lib/identity.server.js`).
- **Purchase reconciliation** — `orders/paid` records every paid order; a delayed cron pass backfills the
  GA4/Meta purchase for any order the storefront pixel never delivered (ad blockers, ITP, sandbox
  failures), deduped so it can only fill a gap — pushing purchase capture toward 100%
  (`app/lib/reconcile.server.js`). The **revenue it recovers** (orders the pixel missed entirely) is
  totalled on the Accuracy page.
- **Value-based optimisation** — send **margin** (flat %) or **true profit (COGS)** as the conversion
  `value` instead of raw revenue, so ad platforms bid on profit. COGS reads each variant's Shopify
  "Cost per item" server-side (`app/lib/cogs.server.js`); raw revenue is kept as a `revenue` param.
- **Revenue by channel** — order revenue attributed to its first-touch source/medium, on the Attribution
  page (`byChannelRevenue` in `app/lib/attribution-report.js`).
- **Proactive alerting** — the cron posts tracking-health alerts (dead-lettered sends, capture/delivery
  drops, retry backlog) to a Slack/Discord/Teams/generic webhook, deduped on a cooldown
  (`app/lib/alerting.server.js`).
- **Match-quality diagnostics** — per-day Meta identifier coverage (email/phone/…) surfaced on the
  Accuracy page, so merchants can see and lift what drives Event Match Quality.
- **Double-counting detection** — scans the storefront for existing trackers (native channels, theme
  tags, other apps) and warns before they double-count (`app/lib/pixel-scan.server.js`).
- **Abuse guard** — the public ingest endpoints are rate-limited per shop + IP (`app/lib/ratelimit.server.js`).
- **Subscription conversion tracking** — `orders/paid` → a GA4 `subscription_purchase` event with
  `subscription` / `subscription_interval` (per-order + per-line) and the actual discounted amount,
  delivered server-side **within seconds** of the order (the webhook records + kicks off delivery so it
  never blocks Shopify's 5s timeout; the cron pass is a durable backstop). `app/lib/subscription.js`
  (pure builders) + `app/lib/subscription-cron.server.js` (record + immediate/backstop delivery); spec:
  [seo-subscription-tracking-v1](../../docs/specs/seo-subscription-tracking-v1.md).

## Structure
```
app/routes/app._index.jsx    tracking dashboard
app/routes/app.tracking.jsx  platform IDs · event matrix · consent · server-side · subscription
app/routes/app.events.jsx    live event observability (RecentEvent)
app/routes/app.settings.jsx  server-side keys (GA4 MP secret / Meta CAPI) + config export/import
app/routes/proxy.$type.jsx   /track ingest → server-side fan-out
app/routes/webhooks.orders.paid.jsx   records the paid order + kicks off immediate subscription delivery
app/routes/cron.tick.jsx     background worker: outbox retries · reconcile · subscription backstop · FX · purge
app/lib/{server-side,subscription,subscription-cron,activity}.server.js · extensions/tracking-pixel
```

## Free — billing defined but not enforced
Every feature is available with no Pro gate. A `Pro` plan is **defined** (`app/lib/billing.server.js`,
wired into `shopify.server.js`) so it's ready to charge later, but nothing calls `billing.require` until
`BILLING_ENFORCED=true` — flipping that is the only change needed to start gating. Unused SEO tables
(SeoSettings, Redirect404Log, …) remain in the schema but are dormant — left in place to avoid a
destructive migration (drop later if desired).

## First run
```bash
cd app/pixelify-seo
cp .env.example .env
docker compose up -d db
npm install
shopify app config link      # links to "Pixel Kicks Tracking"
npx prisma migrate dev
shopify app dev
```
Turn it on: **Settings** → GA4 Measurement Protocol secret; **Tracking** → enable platforms, Server-side,
and Subscription conversion tracking.

## Deploy
Production hosting (Railway), the sign-off step, background worker (`/cron/tick`) and per-client setup
are in the **[deploy runbook](DEPLOY.md)**.
