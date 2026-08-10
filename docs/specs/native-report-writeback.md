# Spec: attribution write-back → Shopify native reporting

> **Status: IMPLEMENTED (2026-08-10).** Order + customer metafield write-back (live + historical backfill),
> definitions provisioner, and the `write_orders`/`write_customers` scope bump are all shipped. Needs a
> `shopify app deploy` for the scope re-consent to take effect. Code: `app/lib/report-writeback.server.js`,
> `app/lib/metafield-backfill.server.js`, `webhooks.orders.paid.jsx`, `webhooks.app.scopes_update.jsx`,
> Attribution page "Write attribution into Shopify's reporting" card.

Scopes a feature that pushes Connect Analytics' resolved attribution onto native Shopify objects (orders,
optionally customers) as **metafields**, so it becomes queryable inside Shopify's own reporting/analytics
section, order pages, and customer segments. Planning artifact for sizing and for the client call.

Shares the `subscription_type` marker and channel resolution with
[subscription-attribution-cac.md](subscription-attribution-cac.md) — build the two together.

## The goal ("done")

The merchant can open Analytics → Reports in their Shopify admin and build a report grouped by **the real
acquisition channel/source/campaign** — `FROM orders SHOW sum(net_sales) GROUP BY <our metafield>` — without
leaving the admin or exporting anything. Every order page shows where that customer actually came from.
Customer segments like "acquired via Paid Search" become usable in Shopify Marketing and Flow.

## The hard limitation (state it plainly)

Shopify's Analytics/ShopifyQL runs against a **closed data warehouse**. There is:

- **No** app API to register a new data source (you cannot make `FROM connect_analytics` appear).
- **No** way to push our own charts/metrics/tiles into the native Analytics dashboards.
- **No** way to retroactively rewrite the session attribution Shopify already recorded (same root cause as
  the GA4 Unassigned problem — a session that was never captured cannot be back-edited).

The **only** supported integration surface is writing our data onto native Shopify objects as **metafields**.
Once a metafield **definition** exists, that field becomes a first-class column in the report builder and a
usable trait in customer segments. So we are not duplicating Shopify's data — we are **correcting it inside
Shopify's own reporting**, using the first-touch we resolved even where Shopify lost it (Recharge
self-referral, in-app browsers). That is the whole value.

---

## 1. Order metafield write-back (live path) · effort: M (~1 day)

**Priority: high.** The core of the feature.

**What.** On the `orders/paid` webhook — Shopify's source of truth and the only path that sees every order,
including subscription renewals — stamp the order with our resolved attribution as metafields under a
`connect_analytics` namespace.

**Fields (order-level).** All already resolved by the attribution engine:

| Metafield key        | Type                    | Source in our code                                  |
|----------------------|-------------------------|-----------------------------------------------------|
| `source`             | single_line_text_field  | `CustomerAttribution.source` / `parseUtms`          |
| `medium`             | single_line_text_field  | `CustomerAttribution.medium`                        |
| `source_medium`      | single_line_text_field  | derived pairing (the GA4-style column)              |
| `channel`            | single_line_text_field  | `channelGroupOf` (attribution-report.js)            |
| `campaign`           | single_line_text_field  | `CustomerAttribution.campaign`                      |
| `subscription_type`  | single_line_text_field  | `new` \| `renewal` (shared with CAC item 1)         |
| `first_touch_at`     | date                    | first-touch timestamp                               |
| `days_to_convert`    | number_integer          | first touch → this order                            |
| `touches`            | number_integer          | count from `VisitorAttribution.touches`             |
| `landing_page`       | single_line_text_field  | `order.landing_site` first-visit landing            |
| `referrer`           | single_line_text_field  | first-visit referrer domain                         |
| `last_source_medium` | single_line_text_field  | last-touch pairing (first-vs-last compare)          |

**How.**
- Add a `writeOrderAttribution({ admin, orderGid, attribution })` helper (`app/lib/report-writeback.server.js`)
  that calls the GraphQL `metafieldsSet` mutation (upsert by namespace+key, up to 25 metafields/call).
- Call it from the `orders/paid` delivery path (`delivery.server.js`), reusing the resolved attribution we
  already compute there. Gate behind the existing `ProcessedWebhook` idempotency so re-delivery is a no-op;
  `metafieldsSet` is an upsert, so retries are safe anyway.
- Best-effort: a metafield-write failure must not bubble a 500 back to the webhook (same pattern as
  `recordDeliveries`).

**Done.** Every new paid order carries the `connect_analytics.*` metafields; they show on the order page.

## 2. Metafield definitions (makes them report-visible) · effort: S (~2–4h)

**Priority: high — without this the values are stored but NOT usable in reports.**

**What.** Create a `metafieldDefinitionCreate` for each order key above, so Shopify exposes them as
columns/filters in the report builder and pins them on the order page.

**How.**
- A one-shot provisioner run on app install / first write (idempotent — creating an existing definition
  returns a "taken" error we swallow). Set an appropriate `access` level and `pin: true`.
- Choose stable, human-readable names ("Acquisition channel", "Acquisition campaign", …) — these are the
  labels merchants see in the report builder.

**Caveat.** Grouping/filtering by a metafield in the native report builder needs a plan that supports custom
report columns (Shopify tier and up; Basic is limited). Naturaw has the ShopifyQL editor, so they're covered
— but flag it per client, don't assume it.

**Done.** The fields appear as selectable dimensions/filters in Analytics → Reports.

## 3. Historical backfill of order metafields · effort: M (~1 day)

**Priority: medium-high.** This is what makes the reports immediately useful instead of "starts populating
today."

**What.** Stamp metafields onto **past** orders using the attribution we already resolved in the two-window
backfill — including the corrected channel for orders Shopify recorded as self-referral/direct.

**How.**
- Reuse the existing `BackfillJob` infrastructure and cursor pattern. Iterate resolved orders, batch
  `metafieldsSet` calls (25 metafields/order, so effectively one call per order), throttle to respect the
  GraphQL cost budget.
- Idempotent by nature (upsert). Resumable via the existing cursor so a rate-limit pause doesn't lose place.
- Depth = the backfill's attribution window. Orders older than what we've resolved won't get stamped unless
  the window is widened (same trade-off called out in the CAC spec item 3).

**Done.** Historical orders carry metafields; a report over a past range is populated, not empty.

## 4. Scope bump + re-consent · effort: S (~1–2h) · has a merchant-facing cost

**What.** `write_orders` is required to write order metafields. It is **not** in our current scope set
(`write_pixels,read_customer_events,read_orders,read_all_orders,read_customers,read_fulfillments,read_products`).
Adding it triggers **merchant re-consent** on next deploy / dev restart.

**How.** Add `write_orders` to `shopify.app.toml` `access_scopes.scopes`. Handle the re-grant flow. Surface a
one-line explainer in-app ("we now write attribution onto your orders so it shows in Shopify reporting").

**Done.** App holds `write_orders`; re-consent handled cleanly with an in-app explanation.

## 5. (Optional) Customer-level write-back · effort: M (~1 day) · needs a SECOND scope

**Priority: low / defer.** Adds acquisition traits to the **customer** record, enabling native customer
**segments** and Marketing/Flow triggers.

**Fields (customer-level).** `acquisition_channel`, `acquisition_campaign`, `acquisition_date`, and an
`ltv_channel` bucket — all from `CustomerLifetime` / `CustomerAttribution` (their first channel EVER, not
per-order).

**Cost.** Needs `write_customers` (we hold only `read_customers`), a second scope bump. Ship order-level
(items 1–4) first to keep the initial re-consent minimal; add this later if a client wants segmentation.

**Done.** Customers carry acquisition traits; segments like "acquired via Paid Search" are buildable.

---

## Out of scope / won't work

- **Custom `FROM` source / app tiles in native Analytics** — not exposed by Shopify (see limitation above).
- **Multi-touch models** (linear, position-based, time-decay) — can't sit cleanly in a single scalar
  metafield; these stay in the app's own Attribution page.
- **`utm_term` / `utm_content`** — only populated when the ad platform passes them, so those columns will be
  blank for a lot of traffic. Include if wanted, but set expectations. (Left out of item 1's field list for
  that reason; trivial to add.)
- **Marketing Activities API** (rolling campaigns + spend into Shopify's Marketing analytics) — a heavier,
  separate path; hold unless a client specifically asks for spend rollup.

## Sequencing

MVP that delivers the promise: **items 1 + 2 + 4** (write on live orders, define the fields, take the scope)
— roughly **1.5–2 days**, and the reports populate going forward. Add **item 3** (historical backfill, ~1 day)
to make past ranges usable — recommended, since a subscription business's key question is historical. Defer
**item 5** (customer segments) and its second scope bump unless asked.
