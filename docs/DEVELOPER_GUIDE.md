# Connect Analytics — Developer Guide

The onboarding doc for anyone inheriting this app. It explains **how the whole system fits together**, the
**mental models** you need before changing anything, the **landmines**, and **how to make common changes
safely**.

Read this alongside the two other top-level docs, which this one deliberately does not duplicate:
- [`README.md`](../README.md) — what the app does, feature by feature.
- [`DEPLOY.md`](../DEPLOY.md) — the step-by-step production deploy runbook (Railway + Shopify).

If you read nothing else, read **§2 (the two deploy targets)** and **§12 (landmines)**. Most of the ways to
break this app in production are in those two sections.

---

## 1. What this app is (in one paragraph)

**Connect Analytics** is a Shopify app that does **accurate server-side conversion tracking + marketing
attribution**. Storefront events (page views, product views, checkouts) are captured two ways, sent to the
app's own server, and **fanned out server-side** to GA4, Meta, TikTok, Pinterest, Snap, Reddit, LinkedIn,
Bing, Klaviyo and server-side GTM — so conversions survive ad blockers, Safari ITP and the checkout sandbox.
On top of delivery it does **attribution** (first-touch, channel groups, multi-touch, subscription-renewal
attribution GA4 can't do) and **writes that attribution back into Shopify's own reporting** as order/customer
metafields. It is currently a **free, tracking-only** app; the SEO feature set was archived to the
`archive/seo-full-featured` branch (which is why the directory is still called `pixelify-seo`).

---

## 2. The two deploy targets ⚠️ THE most important thing to understand

This app deploys to **two independent places**. Confusing them is the single most common way to ship a change
that appears to do nothing (or half-works). There is no single "deploy" that covers both.

| You changed… | Deploy with | Reaches | Notes |
|---|---|---|---|
| **Server code** — anything under `app/` (routes, `lib/`), `prisma/` (schema + migrations) | `git subtree push --prefix=app/pixelify-seo seo-app main` | **Railway** (the Node server + Postgres) | Railway auto-deploys on push to the `seo-app` repo's `main`. Runs `prisma migrate deploy` on boot (`npm run setup`). |
| **Extensions** — `extensions/tracking-pixel` (Web Pixel), `extensions/seo-engagement` (theme embed) | `shopify app deploy` | **Shopify** (hosts the extensions) | Also the ONLY thing that pushes **`shopify.app.toml`** changes: **access scopes**, webhook subscriptions, app proxy config. |

### Why this exists

This monorepo (`pixelify`) contains many things. The Connect Analytics app lives in `app/pixelify-seo`, which
is **published to a standalone GitHub repo (`SEO-APP`) via `git subtree`**. Railway watches that standalone
repo. So "deploy the server" = subtree-push the prefix to `seo-app main`. Shopify, separately, hosts the two
extensions and holds the app config — those only update via `shopify app deploy`.

### The rule of thumb

- Touched a **scope**, a **webhook subscription**, the **app proxy**, or an **extension's code**? → you need
  `shopify app deploy` (and, for scopes, **merchants must re-consent**).
- Touched **anything else** (server logic, a Prisma model, a React admin page, a cron job)? → you need the
  **subtree push**.
- Touched **both**? → you need **both**, and usually the subtree push first (so the server understands the new
  scope/extension before it goes live).

### Subtree mechanics

```bash
# From the monorepo root (/…/pixelify), on whatever branch has your commits:
git subtree push --prefix=app/pixelify-seo seo-app main
```

You do **not** need to merge to `main` for this — subtree push takes the prefix content from your current
`HEAD`. Merging to `main` is just repo hygiene / PR flow. The `seo-app` remote must exist (`git remote -v`);
if not: `git remote add seo-app https://github.com/pixelkicks-jamesknowles/SEO-APP.git`.

---

## 3. Repo layout & naming

```
app/pixelify-seo/                 ← THE APP (this is what deploys to Railway via subtree)
  app/
    routes/                       ← Remix routes: admin pages, webhooks, public endpoints
    lib/                          ← all business logic. *.server.js = server-only; *.js = pure/isomorphic
    components/                   ← shared Polaris components
    shopify.server.js             ← Shopify app config (auth, webhooks, API version)
    db.server.js                  ← Prisma client singleton
    root.jsx                      ← Remix root
  prisma/
    schema.prisma                 ← the data model (Postgres)
    migrations/                   ← SQL migrations (run via `prisma migrate deploy` on Railway boot)
  extensions/
    tracking-pixel/               ← the Web Pixel (checkout + storefront events, sandboxed)
    seo-engagement/               ← the theme app embed (main-page context: durable id, /visit beacon)
  docs/
    DEVELOPER_GUIDE.md            ← you are here
    specs/                        ← design/planning docs for features (read before touching that feature)
    app-listing/                  ← store listing, privacy policy, reviewer notes
  scripts/cron-tick.mjs           ← the external cron caller (Railway cron service hits /cron/tick)
  README.md, DEPLOY.md
```

**Naming gotcha:** the directory, the app proxy subpath (`pixelify-seo`), the durable-id cookie (`pxp_id`),
and the Web Pixel handle (`tracking-pixel`) are **internal identifiers** — do not rename them, it breaks live
installs. The **merchant-facing** name is "Connect Analytics" (copy only). See the rename history in git if
curious.

---

## 4. Tech stack

- **Remix v2** (Vite) + **React 18** + **Shopify Polaris 12** for the embedded admin.
- **`@shopify/shopify-app-remix`** for auth (managed install + token exchange), webhook verification, and the
  App Proxy. API version is pinned in `shopify.server.js` (currently `ApiVersion.April26`).
- **Prisma 6 / PostgreSQL** for all persistence. Sessions are stored in Postgres via
  `@shopify/shopify-app-session-storage-prisma`.
- **Runtime:** `remix-serve` (`npm run start`). ⚠️ This uses `@remix-run/web-fetch`, which has **no static
  `Response.json()`** — see §12.
- **Hosting:** Railway (Node service + Postgres). No in-process scheduler — a Railway **cron service** hits
  `/cron/tick` (see §7).
- **Node:** `>=20.19 <22 || >=22.12` (see `engines`). **pnpm is pinned to 10.x** in the monorepo (pnpm 11 has
  an esbuild build-script regression).
- **Tests:** Jest. There is a **coverage ratchet** (see §11).

---

## 5. The core data flow (how an event becomes a GA4 conversion)

There are **two capture channels** because neither alone is sufficient:

### Channel A — the theme app embed (`extensions/seo-engagement`)
Runs in the **main page context**, so it can call the **same-origin App Proxy**. On load it:
1. `GET /apps/pixelify-seo/id` → mints/refreshes the durable first-party id (`pxp_id`).
2. `POST /apps/pixelify-seo/visit` → a lightweight beacon carrying `{ clientId (_ga), durableId (pxp_id),
   utm, referrer, gtag }`. This does **not** fan out to GA4 (that would double-count page views); it only
   writes `VisitorAttribution` (first-touch) + `VisitorIdentity` (the identity graph).
3. Writes the shopper's real GA4 `client_id` + `session_id` into **cart attributes**, so they arrive on the
   order as note attributes (this is how server-side purchases join the shopper's real GA4 session — see
   the "session stitching" note in README).

The proxy routes are all in [`app/routes/proxy.$type.jsx`](../app/routes/proxy.$type.jsx). The subpath
`pixelify-seo` must match `[app_proxy].subpath` in `shopify.app.toml`.

### Channel B — the Web Pixel (`extensions/tracking-pixel`)
Runs in Shopify's **strict sandbox**, which **cannot** reach the same-origin proxy and **cannot read the
`pxp_id` cookie**. So it beacons **cross-origin** to [`app/routes/pixel.track.jsx`](../app/routes/pixel.track.jsx)
(`/pixel/track`). It sees `checkout_completed` (the purchase) and other customer events, and carries the GA4
`client_id` (from `_ga`) — but **no durable id**. This asymmetry is why identity stitching is subtle (§6).

### Server-side ingest + fan-out
Both channels funnel into [`app/lib/ingest.server.js`](../app/lib/ingest.server.js) → `ingestEvent()`:
1. Bot filtering, rate limiting, PII-redacted buffering for the Live Events view.
2. First-touch resolution + identity linking.
3. **Fan-out** via [`app/lib/server-side.server.js`](../app/lib/server-side.server.js) → builds a
   destination-specific payload for each configured platform (GA4 MP, Meta CAPI, TikTok, Pinterest, Snap,
   Reddit, LinkedIn, Bing, Klaviyo, sGTM) and delivers it. **Matrix-gated:** each shop configures which
   events go to which destinations (`eventMatrix` in `TrackingSettings`).
4. Failures go to the **outbox** for retry; purchases get **capture-stamped** so reconciliation doesn't
   double-send.

### Order webhooks (the source of truth)
[`webhooks.orders.paid.jsx`](../app/routes/webhooks.orders.paid.jsx) is the backbone of the money side. It:
- Counts the order (Accuracy match-rate denominator).
- Records **revenue by channel** (`ChannelRevenueDaily`) + the richer **acquisition** rollup
  (`AcquisitionDaily`, split by order-type × customer-type) — because renewals never fire a storefront
  checkout, this webhook is the **only** path that sees them.
- Records a **PendingPurchase** (reconciliation backstop) and, for subscription orders, a
  **PendingSubscription** + kicks off immediate delivery.
- Fires the **metafield write-back** (attribution onto the order/customer, best-effort, off the ACK path).
- Everything is gated behind a `ProcessedWebhook` idempotency row so a redelivery is a clean no-op.

---

## 6. Subsystem map (where each `lib/` module lives conceptually)

### Identity & durable id
- `durable-id.server.js` — mint/read the `pxp_id` first-party cookie. **Caveat:** App Proxy doesn't pass
  `Set-Cookie` to the browser, so the embed persists the id from the response body as a *script-written*
  cookie (subject to ITP's 7-day cap). A true fix needs a first-party subdomain (see
  `specs/first-party-subdomain.md`).
- `identity.server.js` — the identity **graph**: links `durableId ↔ GA4 clientId ↔ customerKey`.
  `linkIdentity()` is the key function. **The cross-channel stitch** (a checkout event has the customer +
  client id but no durable id) attaches the customer to durable identities sharing that client id — this is
  what makes the "Identified" metric climb off 0. Also `captureHealth()` (the Home observability tile).

### Attribution
- `attribution.js` (pure) — parse UTMs off an order, compute the stable `customerKey`.
- `attribution-report.js` (pure) — all the report aggregations: `byFirstTouch`, `byChannelGroup`
  (GA4-style channel classification), `byChannelRevenue`, `ltvByChannel`, `bySubscriptionSource`,
  `byAcquisition` (the new vs returning × channel × campaign report).
- `multi-touch.js` (pure) — credit distribution models (last/first/linear/position/time-decay).
- `backfill.server.js` + `backfill.js` — rebuild revenue-by-channel from Shopify order history (two-window:
  scan 3 years to learn first-touch, aggregate revenue for 90 days). Leased + resumable via the cron.

### Subscriptions
- `subscription.js` (pure) — GA4 event builders (`buildSubscriptionEvent`, `buildOrderPurchaseEvent`),
  interval parsing, and the order/customer-type classifiers (`orderTypeOf`, `customerTypeOf`,
  `rechargeOrderType`).
- `subscription.server.js` — resolve selling-plan cadence from the Admin API.
- `subscription-cron.server.js` — the deferred subscription conversion pipeline (`processOne`,
  `processSubscriptionNow`, `processPendingSubscriptions`). Leased so the immediate + cron paths never
  double-send.

### Delivery reliability
- `server-side.server.js` — the big one: builds every destination's payload + delivers. Also the shared hash
  helpers, `numericId`, `stableClientId`, etc.
- `outbox.server.js` — durable retry queue (`DeliveryOutbox`) with backoff, drained by the cron.
- `reconcile.server.js` — the accuracy backstop: `orders/paid` records a PendingPurchase; a delayed cron pass
  backfills any GA4/Meta purchase the pixel never delivered. `PurchaseCapture` prevents double-sends.
- `delivery.server.js` — the write helpers: `recordDeliveries`, `bumpDaily` (the `TrackingDaily` counters),
  `recordChannelRevenue`, `recordAcquisition`, `recordVisit`, match-quality rollups.
- `heartbeat.server.js` / `heartbeat.js` — worker liveness (drives the "Worker" badge + `cron_stale` alert).

### Consent, security, infra
- `consent.js` (pure) — `analyticsConsented(consent)` (unknown = granted).
- `secrets.server.js` — encrypt/decrypt at rest (destination tokens, stored order payloads). Uses
  `APP_ENCRYPTION_KEY`.
- `net.server.js` — `fetchWithTimeout` + the SSRF guard (`isSafePublicHttpsUrl`) used for sGTM + alert
  webhook URLs.
- `ratelimit.server.js` — per-IP / per-shop ingest limits.
- `pixel-token.server.js` — the shared secret guarding `/pixel/track`.

### Reporting write-back (native Shopify reporting)
- `report-writeback.server.js` — stamp `connect_analytics.*` metafields onto orders/customers via
  `metafieldsSet`; `provisionDefinitions` creates the metafield definitions (so they're report-builder
  columns); `classifyOrderViaAdmin` (best-effort order-type/customer-type lookup for the live one-off path).
- `metafield-backfill.server.js` — stamp metafields onto **historical** orders (leased + resumable, cron).
  See `specs/native-report-writeback.md`.

### Alerting & health
- `health.js` (pure) + `health.server.js` — compute a shop's ranked health alerts + the data-quality score.
- `alerting.server.js` — push those alerts to a shop's incoming webhook (Slack / Discord / **Teams**). The
  payload is **shaped per target** (Teams Workflows needs an Adaptive Card, not `{text}`) — see the function
  `buildAlertPayload`.
- `connection-check.server.js` — periodic GA4 debug-endpoint verification.

### Other
- `fx.server.js` — daily FX snapshot for multi-currency normalization (`FX_RATES_URL`).
- `cogs.server.js` — resolve order cost of goods (true-profit conversion value).
- `google-ads.server.js` + `google.oauth.callback.jsx` — Google Ads Enhanced Conversions (OAuth, gated).
- `wizard.js` — the guided setup wizard state machine.
- `web-pixel.server.js` — `syncWebPixel()` pushes the effective config to the Web Pixel sandbox.
- `billing.server.js` — the Pro plan is **defined but NOT enforced** (`BILLING_ENFORCED`); the app is free.

---

## 7. The background worker (`/cron/tick`)

There is **no in-process scheduler**. A Railway **cron service** hits [`cron.tick.jsx`](../app/routes/cron.tick.jsx)
on a schedule (`scripts/cron-tick.mjs` is the caller; `TICK_URL` + `CRON_SECRET` configure it). The endpoint
is guarded by a constant-time `CRON_SECRET` header compare. Each tick runs, in parallel, best-effort:

1. `drainOutbox` — retry failed server-side sends.
2. `reconcilePending` — backfill GA4/Meta for purchases the pixel missed (20-min grace window).
3. `processPendingSubscriptions` — the deferred subscription conversion pipeline.
4. `refreshFxRates` — daily FX snapshot.
5. `purge` — TTL cleanup of transient tables.
6. `runConnectionChecks` — GA4 verification (throttled ~6h/shop).
7. `runAlerts` — push health alerts to configured webhooks.
8. `processBackfill` — advance a few pages of a revenue-by-channel backfill.
9. `processMetafieldBackfill` — advance a few pages of a historical metafield write-back.

**Invariant to preserve:** every job is leased/idempotent so overlapping ticks can't double-process. Batch
limits are bounded so a stuck batch can't outlive its lease (see the `LEASE_MINUTES` comments in
`outbox.server.js` / `reconcile.server.js`). If you add a job, keep it best-effort — a slow job must never
wedge the tick.

---

## 8. Data model (Prisma) — grouped by purpose

Full schema: [`prisma/schema.prisma`](../prisma/schema.prisma). The models, by area:

- **Config/identity:** `Session`, `Shop`, `TrackingSettings` (the shop's whole config), `GoogleToken`.
- **Storefront tracking counters:** `TrackingDaily` (orders/events/consent/purchase-consent daily rollup),
  `MatchQualityDaily`, `RecentEvent` (Live Events buffer), `ActivityLog`.
- **Delivery reliability:** `DeliveryLog`, `DeliveryOutbox`, `PendingPurchase`, `PurchaseCapture`,
  `PendingSubscription`, `ProcessedWebhook`, `CronHeartbeat`.
- **Attribution:** `VisitorAttribution` (first/last touch + touch path), `VisitorIdentity` (the identity
  graph), `CustomerAttribution` (first-touch per customer), `CustomerLifetime` (LTV), `ConversionPath`
  (multi-touch input), `ChannelRevenueDaily`, `AcquisitionDaily`, `UnattributedOrder`.
- **Jobs:** `BackfillJob` (revenue backfill), `MetafieldBackfillJob` (metafield write-back backfill).
- **Alerting:** `AlertDismissal`, `AlertNotification`, `ConnectionCheck`.
- **Global:** `FxRate` (the only non-shop-scoped table; excluded from GDPR purge).

---

## 9. Routes map

**Admin (embedded Polaris) pages** — all under `app.*.jsx`, authenticated via `authenticate.admin`:
`_index` (Home), `tracking`, `settings`, `attribution`, `accuracy`, `wizard`, `datalayer` (Developer tools),
`events` (Live), `help`. Plus `app.attribution.unattributed[.]csv.jsx` (CSV export resource route).

**Public / machine endpoints:**
- `proxy.$type.jsx` — the App-Proxy-signed embed endpoints (`/apps/pixelify-seo/{config,id,visit,track}`).
- `pixel.track.jsx` — the cross-origin Web Pixel beacon (`/pixel/track`), guarded by the pixel token.
- `cron.tick.jsx` — the background worker (`/cron/tick`), guarded by `CRON_SECRET`.
- `auth.$.jsx`, `auth.login`, `google.oauth.callback.jsx` — auth flows.

**Webhooks** (`webhooks.*.jsx`, verified by `authenticate.webhook`): `app/uninstalled`, `app/scopes_update`,
`orders/paid`, `orders/cancelled`, `orders/edited`, `refunds/create`, `fulfillments/create`,
`customers/data_request`, `customers/redact`, `shop/redact`. Subscriptions are declared in `shopify.app.toml`
(so changing them needs `shopify app deploy`).

---

## 10. Extensions

- **`tracking-pixel`** (Web Pixel API) — `src/index.js`. Sandboxed; reads `_ga`/`_shopify_y` cookies, gates on
  Customer Privacy consent, beacons to `/pixel/track`. Console tag: `[connect-analytics]`.
- **`seo-engagement`** (theme app embed) — `assets/seo-engagement.js` + `blocks/seo_engagement.liquid`.
  Runs in the main page, mints the durable id, fires `/visit`, writes GA ids into cart attributes. Display
  name "Connect Analytics" (the block schema `name` is capped at **25 chars** — see §12). The merchant must
  **enable this embed in their theme** for durable-id capture + `/visit` to work.

Both are deployed by `shopify app deploy`. Enabling/naming an embed's **handle** must stay stable
(`seo-engagement`) or existing installs break.

---

## 11. Local development & testing

```bash
cd app/pixelify-seo
npm install
npm run dev          # shopify app dev (tunnel + hot reload against a dev store)
npm test             # jest
npm run test:coverage  # enforces the coverage ratchet (see below)
npm run build        # remix vite:build (what Railway runs)
npx prisma generate  # after any schema.prisma change
```

**Coverage ratchet:** `jest.config.cjs` enforces global thresholds (currently ~statements 83 / branches 73 /
functions 73 / lines 87). CI (`.github/workflows/app-tests.yml`) runs plain `npm test`, but **respect the
ratchet** — new server modules with untested functions can drop `functions` below the gate. The pattern for
testing IO code without a live Shopify/DB: pass a **fake `admin` client** (see
`tests/attribution-writeback.test.js`) or use the Prisma mock (`tests/helpers/prisma-mock`, see
`tests/identity.test.js`). Never import `shopify.server` at a module's top level in code that pure tests load —
it initializes the Shopify SDK and throws without env; use a **dynamic import inside the function** (see
`report-writeback.server.js` / `backfill.server.js`).

**Live verification** without a full deploy is fiddly (admin token can't run `theme dev`; the store may be
password-protected). See the `live-verify` notes if you have them; generally, verify server logic with tests
and verify end-to-end on a real dev store after deploy (`DEPLOY.md` Step 7).

---

## 12. Landmines (read before you ship) ⚠️

1. **Two deploy targets.** (§2.) Server change with no subtree push = nothing happens. Extension/scope change
   with no `shopify app deploy` = nothing happens.
2. **Scope changes force merchant re-consent.** Adding to `access_scopes.scopes` in `shopify.app.toml` means
   every merchant must re-approve on next load. Batch scope additions; don't dribble them out.
3. **`remix-serve` has no static `Response.json()`.** Use Remix's `json()` from `@remix-run/node`. The static
   form throws a runtime 500 that never shows in dev/tests. Guarded by `tests/no-response-json.test.js`.
4. **App Proxy strips `Set-Cookie` AND doesn't forward the storefront cookie to the app.** So (a) the durable
   id is a script-written cookie (ITP-capped, not ITP-proof), and (b) server code must read a `durableId`
   from the request **body**, not rely on the cookie. See `durableIdFrom` in `proxy.$type.jsx`.
5. **The Web Pixel can't read `pxp_id`.** Checkout events carry the customer + GA client id but no durable id.
   Identity stitching therefore joins on the **client id** (§6). Keep that in mind before "simplifying"
   `linkIdentity`.
6. **GDPR redaction must stay in sync.** Every new **customer/order-keyed** table must be added to BOTH
   `webhooks.customers.redact.jsx` and `webhooks.shop.redact.jsx` (the `byShopDomain` list).
   `tests/webhooks-gdpr.test.js` enforces the shop-scoped list. `FxRate` is the only intentional exclusion.
7. **Theme app embed block `name` is capped at 25 characters.** "Connect Analytics" (17) is fine; longer
   fails `shopify app deploy` with a theme-check error.
8. **Optional text settings: omit `default`.** In `settings_schema`/extension schema, `"default": ""` fails on
   push (theme-check misses it). Omit the key entirely.
9. **Don't rename internal identifiers.** Directory `pixelify-seo`, proxy subpath `pixelify-seo`, cookie
   `pxp_id`, extension handles. Merchant-facing copy = "Connect Analytics"; identifiers stay.
10. **GA4 dedups purchases on `transaction_id`.** For a one-off order the pixel captured, the **live** send is
    the one GA4 keeps — so any custom dimensions (e.g. `order_type`/`customer_type`) must ride the live
    ingest event, not a later webhook send. See the ingest classify in `ingest.server.js`.
11. **No `Co-Authored-By: Claude` trailer in commits** (project convention).

---

## 13. How-to recipes

### Add a new destination platform (e.g. a new Conversions API)
1. Add its payload builder + delivery in `server-side.server.js` (mirror an existing one like TikTok).
2. Add its credential to `TrackingSettings` (encrypted via `secrets.server.js`) + a Settings UI field.
3. Wire it into the event matrix so it's per-event gateable.
4. If it has reliable server-side dedup, add it to `RECONCILED_DESTINATIONS` so reconciliation covers it.
5. Tests for the pure builder. Deploy = **subtree push** (server only; no extension/scope change).

### Add a Prisma model / field
1. Edit `prisma/schema.prisma`. **Hand-write a migration** under `prisma/migrations/<timestamp>_name/` (the
   deploy runs `prisma migrate deploy`, not `dev`) — keep it additive where possible.
2. `npx prisma generate` locally (the client is regenerated on Railway too, but keep local in sync).
3. If the table is **customer/order-keyed**, add it to **both** GDPR redact webhooks (landmine #6).
4. If shop-scoped, add it to `shop.redact.jsx`'s `byShopDomain` list.
5. Deploy = **subtree push**.

### Add a scope
1. Append to `access_scopes.scopes` in `shopify.app.toml` **and** the `SCOPES` env note in `DEPLOY.md`.
2. `shopify app deploy` (this is a scope change → merchant re-consent).
3. If it needs Shopify approval first (e.g. `read_all_orders`), request it in the Partner dashboard before
   deploying, or the deploy fails. See `DEPLOY.md` Step 5b.

### Add a webhook
1. Add the subscription block in `shopify.app.toml` + the `webhooks.<topic>.jsx` route.
2. `shopify app deploy` (config change).
3. Gate the handler behind `ProcessedWebhook` for idempotency.

### Add a cron job
Add it to the `Promise.all` in `cron.tick.jsx`, best-effort (`.catch`), leased/idempotent, bounded batch.
Deploy = subtree push.

### Change an admin page / report
Pure Remix + Polaris. Aggregations belong in a pure `*.js` lib module (testable) — see `attribution-report.js`.
Deploy = subtree push.

---

## 14. Specs & roadmap

Design docs live in [`docs/specs/`](./specs/). Read the relevant one before touching a feature:
- `native-report-writeback.md` — the metafield write-back to native Shopify reporting.
- `equaliser-aug2026-requests.md` — order/customer-type GA4 dims + diagnosis (supersedes the CAC spec's item 1).
- `subscription-attribution-cac.md` — CAC-by-channel/campaign (parts parked).
- `first-party-subdomain.md` — the ITP-proof durable-id upgrade (needs a merchant DNS CNAME).
- `tracking-features-roadmap.md` — the broader roadmap.

---

## 15. Glossary

- **Durable id (`pxp_id`)** — a first-party visitor id minted by the app proxy, so a returning visitor is one
  person across sessions even after `_ga` churns.
- **Client id** — the GA4 `_ga` cookie id. The join key between the embed and the Web Pixel.
- **First-touch** — the source/medium/campaign that first acquired a visitor/customer; never overwritten.
- **Channel group** — GA4-style rollup (Organic Search, Paid Social, …) of source/medium.
- **Reconciliation** — the cron backstop that backfills purchases the storefront pixel never delivered.
- **Outbox** — the durable retry queue for failed server-side sends.
- **Match rate / capture** — share of paid orders for which we delivered a purchase event.
- **Unassigned (GA4)** — GA4's bucket for sessionless conversions (e.g. subscription renewals) it can't
  attribute; the whole point of this app's server-side attribution is to fill that gap.
- **The subtree** — `app/pixelify-seo` published to the standalone `SEO-APP` repo that Railway deploys.

---

*Keep this doc current: when you add a subsystem, a landmine, or a deploy step, update the relevant section.
A stale onboarding doc is worse than none.*
