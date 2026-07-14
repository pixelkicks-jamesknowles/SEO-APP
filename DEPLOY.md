# Deploy runbook — Pixel Kicks Tracking on Railway

This app is **multi-tenant** (everything is keyed by `shopDomain`), so **one Railway deployment
serves all your client stores**. You host it once, in one agency-owned Railway project, and install
it onto each client store via custom distribution.

> ℹ️ **`shopify.app.toml` is already pointed at the live host.** `application_url`, `[auth].redirect_urls`,
> the GDPR/webhook subscriptions, and `[app_proxy]` are all set to the deployed Railway origin — Step 4
> has already been applied on this branch. It's kept below as reference for what that change entails and
> for re-pointing to a new host. To run `npm run dev:local` again you must temporarily swap the host back
> to a tunnel/localhost URL (Shopify rejects internal hosts for webhook + proxy URIs).

Artifacts already in the repo: `Dockerfile`, `.dockerignore`, `railway.json`.

---

## What runs where
- **Railway**: the Remix server (admin UI, app proxy `/proxy/track`, webhooks) + a managed Postgres.
- **Shopify**: hosts the Web Pixel + SEO-engagement theme extension (pushed by `shopify app deploy`).
- **Outbound**: GA4 Measurement Protocol, Meta CAPI, server-side GTM (from the Railway server).

---

## Step 1 — Railway project + Postgres
1. In the **agency Railway account**, create a new project.
2. **+ New → Database → PostgreSQL.** Railway provisions it and exposes `DATABASE_URL`.
3. **+ New → GitHub repo** → the standalone **SEO-APP** repo (the app is at its root, so leave
   **Root Directory** empty / `/`). Railway builds it via the `Dockerfile`. *(If you ever deploy from
   the `pixelify` monorepo instead, set Root Directory = `app/pixelify-seo`.)*
4. Railway detects `railway.json` / `Dockerfile` and builds automatically.

## Step 2 — Environment variables (on the app service)
Set these in **Service → Variables**:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Reference the Postgres plugin: `${{Postgres.DATABASE_URL}}` |
| `SHOPIFY_API_KEY` | The app's client ID — `708d7107539ef297a6230ea9b0716a2a` (the `client_id` in `shopify.app.toml`) |
| `SHOPIFY_API_SECRET` | From Partner Dashboard → your app → **API credentials → API secret key** |
| `SCOPES` | `write_pixels,read_customer_events,read_orders,read_all_orders,read_fulfillments,read_products` (must match `shopify.app.toml` — `read_products` resolves the subscription cadence, omitting it silently breaks `subscription_interval`; `read_all_orders` powers the attribution backfill and is **granted** — see Step 5b) |
| `SHOPIFY_APP_URL` | The app's public host — currently the custom domain `https://tracking.pixelkicks.co.uk` (must match `application_url` in `shopify.app.toml`) |
| `APP_ENCRYPTION_KEY` | A dedicated 32-byte key for merchant-credential encryption — generate with `openssl rand -base64 32`. **Required in production: the app now fails to boot without it** (missing or malformed), so a silent fallback can't orphan credentials. **Set this before storing any server-side keys.** Once set, don't change it or stored credentials must be re-entered. |
| `ALLOW_INSECURE_ENCRYPTION_FALLBACK` | *(optional escape hatch)* Set to `true` only for a deployment already bootstrapped on the `SHOPIFY_API_SECRET`-derived key: it downgrades the boot failure above to a warning so a redeploy isn't bricked while you migrate to a real `APP_ENCRYPTION_KEY`. Leave unset on new installs. |
| `RATE_LIMIT_REPLICAS` | *(optional)* Number of web replicas. The storefront-ingest rate limiter is per-process, so set this to your replica count and the per-shop ceiling is divided across them, keeping the aggregate near the intended global limit. Defaults to `1` (single process). |

`NODE_ENV` and `PORT` are set by the Dockerfile/Railway — don't override. Migrations run
automatically on boot (`prisma migrate deploy` in the container CMD).

> Pick the public URL now (Railway **Settings → Networking → Generate Domain**, or add a custom
> domain like `tracking.youragency.com`). You need it for `SHOPIFY_APP_URL` and Step 4.

## Step 3 — First deploy (server only)
Trigger a deploy. Confirm in the logs: `prisma migrate deploy` applies the migrations, then
`remix-serve` starts. Visiting `SHOPIFY_APP_URL` should return the Shopify auth screen (not a 500).
At this point the **server** is live but Shopify doesn't know the URL yet — that's Step 4.

## Step 4 — Point Shopify at the host  ⚠️ (the sign-off step — breaks localhost dev)
> **Already applied on this branch** (see the note at the top). The steps below document what the live
> config contains and how to re-point it — e.g. when moving to a new Railway host or a custom domain.

Edit `shopify.app.toml`:

1. Set the real host:
   ```toml
   application_url = "https://YOUR-RAILWAY-HOST"

   [auth]
   redirect_urls = [ "https://YOUR-RAILWAY-HOST/auth/callback", "https://YOUR-RAILWAY-HOST/auth" ]
   ```
2. **Uncomment** the GDPR/webhooks + `[app_proxy]` block (it's kept as a ready-to-paste template
   under `[webhooks]`) and set the proxy URL to the host:
   ```toml
   [webhooks.privacy_compliance]
   customer_deletion_url = "/webhooks/customers/redact"
   customer_data_request_url = "/webhooks/customers/data_request"
   shop_deletion_url = "/webhooks/shop/redact"

   [[webhooks.subscriptions]]
   uri = "/webhooks/app/uninstalled"
   topics = [ "app/uninstalled" ]

   [[webhooks.subscriptions]]
   uri = "/webhooks/app/scopes_update"
   topics = [ "app/scopes_update" ]

   [[webhooks.subscriptions]]
   uri = "/webhooks/orders/paid"
   topics = [ "orders/paid" ]

   [[webhooks.subscriptions]]
   uri = "/webhooks/refunds/create"
   topics = [ "refunds/create" ]

   [[webhooks.subscriptions]]
   uri = "/webhooks/orders/cancelled"
   topics = [ "orders/cancelled" ]

   [[webhooks.subscriptions]]          # post-purchase value change → GA4
   uri = "/webhooks/orders/edited"
   topics = [ "orders/edited" ]

   [[webhooks.subscriptions]]          # order_fulfilled lifecycle event → GA4 (needs read_fulfillments)
   uri = "/webhooks/fulfillments/create"
   topics = [ "fulfillments/create" ]

   [app_proxy]
   url = "https://YOUR-RAILWAY-HOST/proxy"
   subpath = "pixelify-seo"
   prefix = "apps"
   ```
   `prefix`/`subpath` must stay `apps`/`pixelify-seo` — they match `proxyPath` in
   `app/routes/app.tracking.jsx` and the SEO-engagement embed.
3. Push the config + extensions to Shopify:
   ```bash
   npm run deploy        # = shopify app deploy
   ```
   > Avoid `shopify app config link` here — it blanks `scopes` and drops the webhook/proxy blocks
   > (known CLI quirk). Edit the toml by hand as above.

After this, `npm run dev:local` will fail (Shopify rejects localhost for webhooks/proxy). For local
work after sign-off, use a tunnel: `npm run dev` (Cloudflare tunnel), not `dev:local`.

## Step 5 — Distribute to client stores
In **Partner Dashboard → your app → Distribution**, pick one:
- **Custom distribution** (no review, per store): enter each client's `*.myshopify.com`, generate the
  one-time install link, send it. Repeat per client. All point at the same Railway backend.
- **Unlisted (public) distribution** (one review, install anywhere): a single link installs on any
  store, not searchable in the App Store.

Installing triggers OAuth against the Railway host and stores the offline token (auto-refreshing).

## Step 5b — `read_all_orders` (needed for the attribution backfill)  ⚠️ Shopify must approve this
The **Attribution → Backfill from order history** job rebuilds revenue-by-channel from Shopify's own order
attribution (each order's customer journey), and replays each customer's **first-touch** channel onto their
**renewals** — so subscription revenue is credited to the channel that actually acquired the subscriber.
GA4 can never do this: a renewal has no browser session, so it has no channel to inherit and reports as
Unassigned forever.

**The catch:** `read_orders` only exposes the **last 60 days** of orders. An established subscriber's
*acquiring* order — the one carrying the UTMs / customer journey — is usually far older. Without
`read_all_orders`, those customers can't have their channel recovered and show as **(unattributed)**.

**Status: granted** (dev dashboard → API access requests → *"Read all orders scope — Your app can access the
full order history for a store."*). It's listed in `shopify.app.toml` and the `SCOPES` env above.

> ⚠️ **Order matters — you cannot declare the scope before it's granted.** Putting `read_all_orders` in the
> toml while it's unapproved makes `shopify app deploy` fail outright with:
> `Version couldn't be created. app_access — Validation errors: scopes: read_all_orders`.
> If you ever see that, the grant hasn't landed (or you're on a different app) — remove the scope, deploy,
> and request it first. The backfill degrades gracefully to the 60-day window in the meantime, so nothing
> breaks while you wait.

To request it on a **new** app: dev dashboard → **API access** → request `read_all_orders`, justification e.g.
> *"Rebuild historical marketing attribution: credit subscription renewal revenue to the channel that
> originally acquired the customer. A renewal has no browser session, so analytics tools cannot attribute it;
> we replay the customer's first-touch source from their acquiring order. Read-only; order data is only
> aggregated into the merchant's own reporting."*

> ⚠️ **Deploying a scope change triggers merchant re-consent** — every installed store must re-approve the
> app on next deploy, and until they do, the app's API calls fail. **Tell the client before you deploy**, and
> make sure Railway's `SCOPES` env matches the toml.

After the re-consented deploy, run **Attribution → Backfill last 90 days** again to rebuild with the full
history now visible.

## Step 6 — Per-client setup (in the app)
For each installed store:
1. **Tracking**: enter GA4 / Meta / GTM IDs, tick events, turn on **Server-side delivery** (+ Consent
   mode, Bot filtering; optionally Subscription / Refund tracking).
2. **Settings**: add the GA4 MP secret, Meta CAPI token, and sGTM URL if used.
3. Enable the **Pixelify SEO engagement** app embed in the store's Theme editor → App embeds (for
   scroll / engaged-content events).

## Step 7 — Verify (the real end-to-end test)
1. **Settings → Verify delivery**: Send test event / purchase / subscription. They validate then fan
   out to every configured destination and log to **Delivery health**. Confirm green.
2. **GA4 → Reports → Realtime** and **Meta Events Manager → Test Events**: confirm the test events land.
3. **Real checkout**: put the store in test mode (Bogus Gateway) and place a test order. That fires
   the genuine Web Pixel `checkout_completed` → app proxy → fan-out, and `orders/paid`. Watch it in
   **Live events** + GA4 Realtime. (This is the only thing that exercises the checkout-capture leg.)

## Step 8 — Background worker (required for retries, reconciliation + FX)
There's no in-process scheduler, so a cron service must poke `/cron/tick`. Each tick: drains the
delivery retry outbox (re-sends failed GA4/Meta/GTM/Google-Ads events with backoff), reconciles pending
purchases (backfills any order the storefront pixel never captured), finishes any subscription order
whose immediate delivery didn't complete (see note below), refreshes the daily FX snapshot, purges
stale rows, and pushes tracking-health alerts.
1. Set `CRON_SECRET` on the app service (random string).
2. Add a **Railway cron service** (or any external scheduler) that runs every ~5 minutes:
   `curl -fsS -H "x-cron-secret: $CRON_SECRET" https://<your-app>/cron/tick`
3. Confirm: hitting it returns a JSON summary
   (`{ ok, outbox, reconciled, subscriptions, fx, purged, alerts }`). Without the header it 403s.

**Subscription delivery is immediate, not cron-gated.** A paid subscription order is delivered to GA4
server-side within seconds — right after the `orders/paid` webhook ACKs (the webhook records the order,
then kicks off delivery in the background so it never blocks Shopify's 5s webhook timeout). The cron
`subscriptions` pass is only a **backstop** that finishes an order if the app process was restarted
mid-delivery, so the tick interval does **not** affect normal subscription latency — it only bounds how
long a crash-interrupted order waits (≤ the 15-min processing lease). Keep the cron running (every 1–5
min) as that safety net; for a subscription-heavy store, every 1 min tightens the worst case.

> **Host caveat:** immediate delivery runs work *after* the HTTP response, which relies on a long-lived
> process (Railway is fine). On a serverless host (Vercel/Lambda-style) post-response work is killed and
> subscription delivery falls back to cron-interval latency — there, run the cron more frequently.

## Step 9 — Google Ads Enhanced Conversions (optional, gated)
Stays completely hidden until configured, so skip unless wanted.
1. Get **Google Ads API access** (a developer token — approval can take a while).
2. Create a Google Cloud OAuth **Web application** client; add redirect URI
   `<SHOPIFY_APP_URL>/google/oauth/callback`.
3. Set `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.
4. In-app **Settings → Google Ads**: Connect Google, then enter the customer ID + conversion action
   ID and enable uploads. Purchases with an on-page `gclid` (or hashed customer data) then upload
   directly, alongside the GA4 path.

---

## Backups (do this — the DB holds OAuth tokens)
- Railway Postgres: enable **backups** in the database service settings.
- Optional belt-and-braces: a scheduled `pg_dump` to Backblaze B2 / S3.

## Day-2
- **Redeploy**: push to the connected branch (or `railway up`). Migrations apply on boot.
- **New migration**: commit it; `prisma migrate deploy` runs automatically on the next deploy.
- **Rollback**: Railway → Deployments → redeploy a previous build. For DB schema, roll forward with a
  new migration rather than down-migrating.
- **Logs / health**: Railway service logs; in-app **Live events → Delivery health** and the Home
  delivery-failures badge show per-destination delivery status.

## Cost (rough)
~$10–20/mo total for the app service + managed Postgres at low/mid client traffic — for all clients
combined, not per client.
