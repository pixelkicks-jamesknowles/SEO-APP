# Deploying pixelify-seo to a real host

Local dev (`npm run dev:local`) deliberately runs **without** webhooks and the app proxy, because
Shopify rejects `localhost`/internal domains for those URIs. Before deploying to a public host you
must restore them — the route handlers already exist; only the `shopify.app.toml` config was stripped.

## 1. Host + env

Deploy the Remix app (Docker is set up; mirror `pixelify-admin`'s Dockerfile/host). Set on the host:

```
SHOPIFY_API_KEY=...           # from Partners (or injected by the platform)
SHOPIFY_API_SECRET=...
SHOPIFY_APP_URL=https://<your-host>
SCOPES=read_products,write_products,read_content,write_content,read_themes,write_themes,read_orders
DATABASE_URL=postgresql://...  # managed Postgres, NOT the docker-compose one
```

Run migrations on deploy: `prisma migrate deploy` (already in `shopify.web.toml` predev/dev and the
`setup` script).

**Optional integration env** (features degrade gracefully if unset):
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Search Console OAuth (`/app/gsc` → `/auth/google`).
  Add `<host>/auth/google/callback` as an authorized redirect URI in Google Cloud. Token exchange,
  refresh, and the Search Console query are implemented (`lib/gsc.server.js`); they're untested
  without real Google credentials + a verified GSC property matching the store domain — verify on
  first deploy. The query uses `https://<shop-domain>/` as the property; adjust if you use
  `sc-domain:` properties.
- `AGENCY_CONSOLE_TOKEN` — gates the standalone agency view at `/console?token=...`.
- `CRON_SECRET` — gates the scheduled re-audit. Point an external scheduler (platform cron, GitHub
  Action, cron-job.org, …) at `GET https://<host>/cron/audit?secret=<CRON_SECRET>` daily. It
  re-audits every shop with monitoring enabled, snapshots the score, and posts a Slack-compatible
  alert (to the shop's configured webhook) on a regression.
- The CrUX (Core Web Vitals) API key is entered per-shop in Settings → Integrations, not via env.

## 2. Restore webhooks + app proxy in `shopify.app.toml`

Replace the `# NOTE: …` block under `[webhooks]` with the real config, and point every URL at
`https://<your-host>`:

```toml
[webhooks]
api_version = "2026-04"

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
  uri = "/webhooks/products/create"
  topics = [ "products/create" ]

  [[webhooks.subscriptions]]
  uri = "/webhooks/products/update"
  topics = [ "products/update" ]

  [[webhooks.subscriptions]]
  uri = "/webhooks/collections/update"
  topics = [ "collections/update" ]

[app_proxy]
url = "https://<your-host>/proxy"
subpath = "pixelify-seo"
prefix = "apps"
```

Also set `application_url` and `[auth].redirect_urls = ["https://<your-host>/api/auth"]`.

## 3. Verify the redirect scope

`urlRedirectCreate` (used by the handle-change 301 logic in
`app/routes/webhooks.products.update.jsx`) may require `write_online_store_pages` rather than
`write_content`. Confirm against the deployed API version and add it to `scopes` if needed —
adding a scope triggers a one-time merchant re-consent.

## 4. Wire the app-proxy URL into the Web Pixel

In `app/routes/app.tracking.jsx`, `pixelSettings.proxyUrl` is `""` for localhost. Once deployed,
set it to `https://<your-host>/apps/pixelify-seo/track` so the Web Pixel's server-side beacon reaches
the proxy ingest (`proxy.$type.jsx`).

## 5. Deploy

```bash
shopify app deploy        # pushes config + extensions; registers webhooks at the real host
```

## What's still TODO (tracked in docs/specs/pixelify-platform-spec-v1.md §11)

- Handle-change 301 persistence (`webhooks.products.update.jsx` is scaffolded).
- `llms.txt` / `llms-full.txt` catalog export (`proxy.$type.jsx` returns a stub).
- Server-side tracking fan-out (GA4 MP / Meta CAPI) in the `track` proxy action.
- SEO meta apply currently does the first 50 products per click; production wants Bulk Operations
  or a background job to cover the whole catalog.
- Schema app embed reads theme-editor block settings; DB-driven config (shop metafield) is a
  follow-up.
