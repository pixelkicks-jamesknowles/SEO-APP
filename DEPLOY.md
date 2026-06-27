# Deploy runbook — Pixel Kicks Tracking on Railway

This app is **multi-tenant** (everything is keyed by `shopDomain`), so **one Railway deployment
serves all your client stores**. You host it once, in one agency-owned Railway project, and install
it onto each client store via custom distribution.

> ⚠️ **Not signed off yet.** The repo is still in localhost mode: the webhook + `[app_proxy]` blocks
> in `shopify.app.toml` are commented out so `npm run dev:local` (`shopify app dev --use-localhost`)
> keeps working. **Step 4 below is the only thing that changes that** — do it only when you're ready
> to deploy. Everything before Step 4 is safe to set up in advance.

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
3. **+ New → GitHub repo** (or `railway up` from the CLI). Point the service at this repo and set
   **Settings → Root Directory = `app/pixelify-seo`** so it builds just this app via its `Dockerfile`.
4. Railway detects `railway.json` / `Dockerfile` and builds automatically.

## Step 2 — Environment variables (on the app service)
Set these in **Service → Variables**:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Reference the Postgres plugin: `${{Postgres.DATABASE_URL}}` |
| `SHOPIFY_API_KEY` | The app's client ID — `16f6275cefd68c235d54aa800f34c189` (also in `shopify.app.toml`) |
| `SHOPIFY_API_SECRET` | From Partner Dashboard → your app → **API credentials → API secret key** |
| `SCOPES` | `write_pixels,read_customer_events,read_orders` (matches `shopify.app.toml`) |
| `SHOPIFY_APP_URL` | Your Railway URL, e.g. `https://pixel-kicks-tracking.up.railway.app` (or a custom domain) |

`NODE_ENV` and `PORT` are set by the Dockerfile/Railway — don't override. Migrations run
automatically on boot (`prisma migrate deploy` in the container CMD).

> Pick the public URL now (Railway **Settings → Networking → Generate Domain**, or add a custom
> domain like `tracking.youragency.com`). You need it for `SHOPIFY_APP_URL` and Step 4.

## Step 3 — First deploy (server only)
Trigger a deploy. Confirm in the logs: `prisma migrate deploy` applies the 4 migrations, then
`remix-serve` starts. Visiting `SHOPIFY_APP_URL` should return the Shopify auth screen (not a 500).
At this point the **server** is live but Shopify doesn't know the URL yet — that's Step 4.

## Step 4 — Point Shopify at the host  ⚠️ (the sign-off step — breaks localhost dev)
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
