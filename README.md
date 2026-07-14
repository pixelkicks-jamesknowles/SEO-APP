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
- **Durable first-party id** — the app proxy mints a stable first-party id (`pxp_id`); the pixel + embed
  both carry it as a stable `client_id`, so a returning visitor is ONE user across sessions even after
  `_ga` expires (`app/lib/durable-id.server.js`). Requires the SEO-engagement theme embed.
  > **Cookie-lifetime caveat.** The proxy returns a `Set-Cookie`, but **Shopify's App Proxy does not pass
  > `Set-Cookie` through to the browser**, so in practice the embed persists the id from the response body
  > as a **script-written** cookie. That means it *is* subject to Safari's 7-day ITP cap (400 days on
  > Chrome/Firefox) — it is **not** the "ITP-proof" server-set cookie this originally claimed. A truly
  > ITP-proof id needs a **custom first-party subdomain** (`CNAME track.<merchant> → the app host`), which
  > is how Elevar/Stape do it. Tracked as a roadmap item; the code already prefers a real server-set
  > cookie if one ever lands, so that upgrade is drop-in.
- **Identity stitching** — a graph links the durable id ↔ GA4 client id ↔ customer, so a conversion
  inherits its visitor's original first-touch across sessions/devices instead of looking direct
  (`app/lib/identity.server.js`).
- **Session stitching (GA4 channel)** — the SEO-engagement embed writes the shopper's real GA4 `client_id`
  (`_ga`) **and `session_id`** (`_ga_<container>`) into cart attributes, which arrive on the order as note
  attributes. `orders/paid` + the reconcile backfill then send the server-side purchase with that **same
  pair**, so GA4 joins the conversion to the shopper's actual browser session and it inherits that
  session's traffic source. Without a `session_id` GA4 opens a new, source-less session and the purchase
  lands in **Unassigned** — which is why webhook-driven (e.g. subscription) conversions lose the channel.
  A recurring renewal has no browser session, so it carries the customer's client id but no session id.
- **Purchase reconciliation** — `orders/paid` records every paid order; a delayed cron pass backfills the
  GA4/Meta purchase for any order the storefront pixel never delivered (ad blockers, ITP, sandbox
  failures), deduped so it can only fill a gap — pushing purchase capture toward 100%
  (`app/lib/reconcile.server.js`). The **revenue it recovers** (orders the pixel missed entirely) is
  totalled on the Accuracy page.
- **Value-based optimisation** — send **margin** (flat %) or **true profit (COGS)** as the conversion
  `value` instead of raw revenue, so ad platforms bid on profit. COGS reads each variant's Shopify
  "Cost per item" server-side (`app/lib/cogs.server.js`); raw revenue is kept as a `revenue` param.
- **Revenue by channel (incl. subscription renewals — the number GA4 can't give you)** — every paid
  order's revenue attributed to the source/medium that first acquired the customer, driven from the
  **`orders/paid` webhook** (Shopify's source of truth), so it includes **recurring renewals**. This is the
  key thing: a renewal never fires a storefront checkout, so it has **no browser session** — GA4 therefore
  has no session to take a channel from and reports it as **Unassigned forever**. The app replays the
  customer's **first-touch** source onto each renewal, and splits `subscriptionRevenue` out per channel, so
  you can actually see which channels drive subscription revenue. On the Attribution page
  (`byChannelRevenue` in `app/lib/attribution-report.js`, recorded in `webhooks.orders.paid.jsx`).
- **Attribution backfill** — rebuilds the above from **Shopify's own order attribution**
  (`Order.customerJourneySummary.firstVisit`), replaying each customer's first touch onto their renewals,
  and seeding `CustomerAttribution` so future renewals inherit it too (`app/lib/backfill.js` pure +
  `backfill.server.js`). Leased + resumable on `/cron/tick`; a fresh run clears the window first so it can't
  double-count, and it only touches days **before today** (the live `orders/paid` path owns today onward).
  Triggered from the Attribution page. **Needs `read_all_orders`** to see past 60 days — see
  [DEPLOY.md Step 5b](DEPLOY.md). Unrecoverable customers are shown as **`(unattributed)`**, never folded
  into `(direct)`.
- **Proactive alerting** — the cron posts tracking-health alerts (dead-lettered sends, capture/delivery
  drops, retry backlog) to a Slack/Discord/Teams/generic webhook, deduped on a cooldown
  (`app/lib/alerting.server.js`).
- **Background-worker heartbeat** — every `/cron/tick` stamps a heartbeat (`app/lib/heartbeat.server.js`);
  the Home dashboard shows a **Worker** badge (healthy / lagging / stopped) and a `cron_stale` health alert
  fires if the worker stops — so a dead cron (missed schedule, unset `CRON_SECRET`) can't silently stall
  retries, reconciliation and subscription delivery. Staleness thresholds are pure + unit-tested
  (`app/lib/heartbeat.js`).
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
