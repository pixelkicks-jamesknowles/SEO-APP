# Tracking features roadmap — dev spec

Remaining tracking features for Pixel Kicks Tracking, scoped against the current architecture so any
can be picked up later. Prioritised for an agency running **B2B + DTC across many industries**. This
doc tracks only work that is **not built yet**.

> **Already shipped** (removed from this list): value-based conversions P1 (store-level margin %, via
> `valueMode`/`marginPct` + `withValueMode`); multi-touch attribution (first- + last-touch + touch
> count in `VisitorAttribution`, surfaced on the Attribution page); multi-currency normalization
> (`fx.server.js`); subscription, refund/cancellation and post-purchase lifecycle tracking; durable
> retry (`DeliveryOutbox`); bot filtering; and Google Ads Enhanced Conversions.

## Current architecture (reference)
- **Capture:** Web Pixel (`extensions/tracking-pixel/src/index.js`) subscribes to the 8 standard
  Shopify customer events and beacons `{ platforms, event }` to the app proxy `/apps/pixelify-seo/track`.
  It attaches `clientId` (from `_ga`), `fbp`/`fbc`, `externalId`/`email`/`phone` (from
  `init.data.customer`), and a `consent` state. The **SEO-engagement embed** (`extensions/seo-engagement/`)
  runs in the storefront DOM and beacons synthetic events (`scroll`, `engaged_view`) to the same proxy.
- **Ingest** (`app/lib/ingest.server.js`, hit by `proxy.$type.jsx` + `pixel.track.jsx`): bot filter
  (`isBot`) → event-id dedup → `recordVisit` (first- + last-touch) → `getFirstTouch` on checkout →
  `fanOutServerSide` → `recordDeliveries` → `enqueueFailures` (outbox).
- **Fan-out** (`app/lib/server-side.server.js`): `fanOutServerSide(settings, event, {hooks})` is
  matrix-gated; builders `ga4EventFor` / `metaEventFor` / `metaUserData` / `extractCommerce` /
  `ga4Consent`; senders `sendGa4` / `sendMeta` / `sendGtmServer` (return `{ok, detail}`). Value-mode
  (margin) via `withValueMode`; multi-currency via `fx.server.js` hooks.
- **Webhooks:** `orders/paid` → `buildSubscriptionEvent` (`app/lib/subscription.js`); `refunds/create`
  + `orders/cancelled` → refund/cancellation builders (`app/lib/refund.js`); `orders/edited` +
  `fulfillments/create` lifecycle events; all via `sendGa4Event` + `recordDeliveries`.
- **Durable delivery:** failed sends queue in `DeliveryOutbox`, retried with backoff by `/cron/tick`
  (`app/lib/outbox.server.js`).
- **Data:** `TrackingSettings` (ids, `eventMatrix` JSON, `serverSideKeys` JSON, toggles),
  `VisitorAttribution` (first- + last-touch + touch count by client_id), `CustomerAttribution`
  (first-touch by customer, for subs/refunds), `TrackingDaily` (counters), `DeliveryLog`, `FxRate`.
- **Cross-cutting:** Consent Mode v2 (`consentMode`/`consentSignals`), bot filtering, dedup
  (transaction_id / event_id), Protected Customer Data granted (order PII), delivery health, Accuracy.

## Priority
| # | Feature | Value for B2B/multi-industry | Effort |
|---|---|---|---|
| 1 | Custom & lead/form events | ★★★ fits every industry + B2B lead-gen | M |
| 2 | B2B/DTC + company segmentation | ★★★ segment every store by model/account | M |
| 3 | Value-based conversions — accurate COGS + LTV (P2/P3) | ★★ optimise for profit | L |
| 4 | Offline / sales-assisted conversions | ★★ B2B closes off-Shopify | L |
| 5 | Customer-match audience sync | ★ account retargeting | L (Meta-first) |

---

## 1. Custom & lead/form events
**Summary.** Let the storefront fire arbitrary events (quote/RFQ, trade-account request, configurator,
consultation, sample request, finance application) → GA4 (`generate_lead`/custom) + Meta (`Lead`/custom).
Removes the "only the 8 DTC events" ceiling.

**Capture.**
- Extend the SEO-engagement embed to expose `window.pxp.track(name, params, { value, currency })`, which
  beacons `{ event: { name, custom: true, params, value, currency, clientId, consent, context } }` to the
  proxy. The agency/theme calls it on form submit / button click.
- (Optional) also `analytics.subscribe('<custom>', …)` in the Web Pixel for events the theme publishes via
  `Shopify.analytics.publish`.

**Server-side.** `fanOutServerSide` already routes arbitrary names. Add a **custom-event registry** in
`TrackingSettings.customEvents` (JSON): `[{ key, ga4Name, metaName, defaultValue? }]`. In `ga4EventFor`,
for a custom event use `ga4Name` and merge `event.params`; in `metaEventFor`, use `metaName` (custom Meta
events are fine — they don't pollute standard events) + `metaUserData` (hash any PII in params). Matrix
must accept custom keys (extend the matrix builder + UI).

**Destinations.** GA4: `generate_lead` (recommended) with `value`/`currency`, or the configured custom
name. Meta: `Lead` (standard) or custom, `event_id` from the event id for dedup.

**UI.** New "Custom events" card on Tracking: define `key → GA4 name + Meta name + destinations + default
value`. Doc snippet for the theme `pxp.track(...)` call.

**Consent/PCD.** Respect consent (marketing for Meta). Hash any email/phone in params via `sha256Hex`.

**Open questions.** Standard event-name vocabulary; how the B2B app's quote/RFQ proxy actions emit a
tracking event (server-to-server call into the proxy, or shared lib).

---

## 2. B2B/DTC + company segmentation
**Summary.** Tag conversions with **customer type (B2B/DTC), company/account, tags, tier,
new-vs-returning** so every store's GA4/Meta data splits by model/account/tier.

**Data source.** Order webhooks (`orders/paid`) carry the full customer + B2B `company`/`purchasing_entity`.
For pixel `checkout_completed`, customer fields are limited; optionally enrich server-side via an Admin API
lookup by customer id (**adds `read_customers` scope** — PCD already covers customer data).

**Server-side.** Derive: `customer_type = company/purchasing_entity present ? "b2b" : "dtc"`;
`company` (name/id); `customer_tags`; `is_new_customer = orders_count === 1`; `customer_tier` (from a tag
convention). Add to:
- GA4: **`user_properties`** (`customer_type`, `customer_tier`) + event params (`company`, `new_customer`).
  Requires adding a `user_properties` field to the MP body in `sendGa4`/`sendGa4Event`.
- Meta: `custom_data` (`customer_type`) + `user_data.external_id` already sent.

**UI.** Toggle "Send B2B/DTC + customer segments". Optional tag→tier mapping.

**Consent/PCD.** Segment fields are non-PII (type/tier/company) except tags; fine under granted consent.

**Open questions.** B2B detection field names in the current webhook API version; whether to add
`read_customers` for pixel-event enrichment or keep it order-only.

---

## 3. Value-based conversions — accurate COGS + LTV
**Shipped already (P1):** store-level margin % → `value = round(revenue × marginPct, 2)`, via the
`valueMode`/`marginPct` settings and `withValueMode`. The remaining phases raise accuracy:

- **P2 (M):** per-line **COGS** via Admin API (`read_inventory`, InventoryItem `unit_cost`) →
  accurate margin = revenue − Σ(cost·qty).
- **P3 (L):** **LTV** — needs historical orders per customer (`read_all_orders`); send predicted/actual
  LTV as value on first purchase.

**Server-side.** Extend `withValueMode` with a `cogs`/`ltv` mode; keep raw revenue as a `revenue` custom
param for reference. Opt-in only.

**Caveat.** Changing `value` changes ROAS reporting in Meta/GA4 — keep it explicit and opt-in.

---

## 4. Offline / sales-assisted conversions
**Summary.** Fire the conversion when a quote/lead is **won later** (B2B closes by phone/email), correlated
back to the original click.

**Mechanism.** Store a lead/click record (`clientId`, `gclid`/`fbclid`, hashed identifiers, value, status,
`createdAt`) at lead time. On win — via a manual "mark won" admin action, an `orders/updated` webhook on a
"won" tag, or an app-proxy/CRM callback — send the conversion with the stored identifiers and
`event_time = win time`.

**Data model.** New `Conversion`/`Lead` entity. **Destinations:** GA4 (stored client_id) + Meta CAPI
(stored fbp/fbc/em, within Meta's ~7-day `event_time` window) + Google Ads offline import (the Google Ads
API path is already wired for Enhanced Conversions, so offline `ClickConversion` uploads can reuse it).

**Effort.** L (entity + correlation + UI). **Caveat.** Document Meta's attribution window; long B2B cycles
may exceed it.

---

## 5. Customer-match audience sync
**Summary.** Push hashed customer/company lists to **Meta Custom Audiences** (and later Google Customer
Match) for account retargeting / lookalikes.

**Mechanism.** A scheduled job (reuse `/cron/tick`) hashes new customers' email/phone and syncs to a
configured Meta audience (Marketing API; needs `ads_management` + audience id + ad-account id). Google
Customer Match needs the Google Ads API (heavy) — Meta-first.

**Data model.** Audience config in `serverSideKeys`; a cursor of last-synced customer. **Consent/PCD:**
marketing consent required; hashed PII only; honour redaction webhooks.

**Effort.** L. Meta Phase 1 only.

---

## Cross-cutting notes
- **Consent Mode v2** must extend to every new event (gate Meta on marketing; GA4 flagged).
- **Dedup**: any new client-or-server event needs a stable `event_id` (Meta) / `transaction_id` (GA4);
  the ingest path already dedups replayed beacons on `event.id`.
- **Delivery health + Accuracy**: route new sends through `recordDeliveries`; add counters to
  `TrackingDaily` where a match-rate makes sense (e.g., leads delivered vs leads captured).
- **Scopes/PCD**: #2 (`read_customers`) and #3-P2/P3 (`read_inventory` / `read_all_orders`) add scopes →
  re-consent + a Protected Customer Data / review pass for the public app.
- **Multi-store/agency**: consider a per-store config template/preset so these can be rolled out across
  many client stores quickly.
- **Not-yet-built residual from shipped work**: the optional full **touch-list journey** (capped
  `{ts, source, medium, campaign}[]` on `VisitorAttribution`) — the current model keeps first/last/count
  but not the ordered list.
