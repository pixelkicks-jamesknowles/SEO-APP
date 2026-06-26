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
- **Server-side tracking** — GA4 Measurement Protocol + Meta CAPI fan-out from the `/track` App-Proxy
  beacon (`app/lib/server-side.server.js`).
- **Subscription conversion tracking** — `orders/paid` → a GA4 `subscription_purchase` event with
  `subscription` / `subscription_interval` (per-order + per-line) and the actual discounted amount
  (`app/lib/subscription.js`; spec: [seo-subscription-tracking-v1](../../docs/specs/seo-subscription-tracking-v1.md)).

## Structure
```
app/routes/app._index.jsx    tracking dashboard
app/routes/app.tracking.jsx  platform IDs · event matrix · consent · server-side · subscription
app/routes/app.events.jsx    live event observability (RecentEvent)
app/routes/app.settings.jsx  server-side keys (GA4 MP secret / Meta CAPI) + config export/import
app/routes/proxy.$type.jsx   /track ingest → server-side fan-out
app/routes/webhooks.orders.paid.jsx   subscription_purchase → GA4
app/lib/{server-side,subscription,activity}.server.js · extensions/tracking-pixel
```

## Free — no billing
Billing + plan tiers were removed; every feature (incl. server-side + subscription) is available with
no Pro gate. Unused SEO tables (SeoSettings, Redirect404Log, …) remain in the schema but are dormant —
left in place to avoid a destructive migration (drop later if desired).

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
