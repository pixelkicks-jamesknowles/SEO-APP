# Spec: Equaliser Aug 2026 requests — diagnosis + order/customer type tracking

Planning artifact for the client's consolidated Aug 2026 list. Sorts their asks into **Part 1 (completing the
phase-1 deliverable — a diagnosis, no new build)** and **Part 2 (new scope — to quote)**, with **Part 3
parked**. Sizing here feeds the quote; it does not set price (apply the day rate to the effort).

Relationship to existing specs:
- **Supersedes** the `subscription_type` marker in [subscription-attribution-cac.md](subscription-attribution-cac.md)
  item 1 — that single new-vs-renewal flag is now generalised into two orthogonal attributes (order type +
  customer type), below.
- **Parks** CAC items 3 (selectable date range) and 4 (CSV export) — see Part 3.

---

## Part 1 — Diagnosis: why ~half of new-subscriber orders have no channel

**Client framing:** completing the phase-1 deliverable, not new scope. **Deliverable: a written diagnosis, not
a build.** Effort: ~0.5–1 day of analysis + write-up.

The pipeline is proven (every order reaches GA4, orders reconcile ~1%). The usability gap is that 52 of 106
matched new-subscriber orders (17–30 July) arrive with **no channel**. The diagnosis answers their three
questions with evidence from our own data, and — critically — draws the **module vs beyond-module** line so
remediation can be costed correctly.

### 1a. Why the match fails, and what a failed match looks like in GA4

**What "match" means.** The module attributes an order by linking it to a captured browsing journey (durable
id `pxp_id` → first-touch source/medium/campaign). A **failed match = no captured journey to attribute**, so
the order is sent with no source.

**What it looks like in GA4.** The event still lands (transaction_id present, revenue correct), but with no
session/source, so GA4 files it under **Unassigned / (direct) / (none)** — indistinguishable from organic
direct traffic. That is the symptom Equaliser is seeing.

**Root causes already identified (all module-adjacent, evidence to be shown):**
- **Recharge checkout redirect** breaks Shopify's own journey — the sale is stamped `shopify.com / referral`
  (a self-referral), so there was never a clean session to inherit a source from.
- **Live capture was not deployed** to the storefront until recently — `shopify app deploy` had not been run
  after the visitor-tracking work, which is exactly why the header showed **Tracked visitors 0**. See 1b.
- **Durable id was not being linked** even once capture ran, because the App Proxy strips the `pxp_id` cookie;
  fixed by sending the id in the request body (now deployed). Identified should now climb off 0.

**Evidence to produce:** a matched-vs-unmatched breakdown for the 106 orders, the durable-id mint/link rate
since the deploy, and the referrer/landing profile of the unmatched set.

### 1b. Is live visitor tracking capturing as intended (the "Tracked visitors 0")

Direct answer with current numbers. The 0 was the **un-deployed embed**, not a broken module — after the
deploy Tracked visitors climbed (0 → 900+ in testing). The write-up confirms this with the live figure at time
of writing and the durable-id health, so "is it capturing?" becomes a number, not a debate. (This is the same
data the proposed **observability tile** — CAC spec item 6 — would surface permanently; recommend building it
so this question never needs a manual investigation again.)

### 1c. Do failures skew to particular journeys (and does that explain Meta 1 of 106)

**Yes — this is the key finding.** Failures concentrate on journeys where the tracking cookie/journey never
survives to checkout:
- **Meta in-app browsers.** Clicks from Instagram/Facebook open in the in-app browser, which blocks the
  third-party cookie the journey relies on. This is why **Meta reads 1 of 106** — almost every Meta-sourced
  subscriber loses their journey before checkout. Evidence: in-app-browser user-agent share among unmatched
  orders.
- **Recharge-redirect journeys** (as in 1a) — over-represented in the unmatched set.

The skew analysis cross-tabs matched vs unmatched by referrer/UA class to show which journeys are lost.

### Module vs beyond-module boundary (for the cost caveat)

Stated plainly so remediation is costed fairly:
- **Within the deliverable (no charge):** the deploy fix, the durable-id-in-body fix, and this diagnosis.
- **Beyond the module (quote separately):** the first-party subdomain that makes capture ITP/in-app-browser
  proof ([first-party-subdomain.md](first-party-subdomain.md), needs their DNS), any consent-configuration
  work, and any site-wide journey-capture issues predating our module. A diagnosis showing an in-app-browser
  root cause points squarely at the subdomain as the structural fix — flag it as the natural Part-2b of
  remediation.

---

## Part 2 — New scope (quote): order-type + customer-type attributes on every order

**Client framing:** beyond the June spec; quote both. Two orthogonal attributes on **every** order, into GA4,
with reporting to match. Together they let Equaliser see, by channel and campaign, **new subscribers**, **new
customers overall**, and **one-off vs subscription** revenue.

The two attributes:

| GA4 event param | Values                                              | Source of truth |
|-----------------|-----------------------------------------------------|-----------------|
| `order_type`    | `subscription_checkout` \| `renewal` \| `one_off`   | Recharge `subscription_order_type` + line-item scan |
| `customer_type` | `new` \| `returning`                                | Shopify `customer.orders_count` (== 1 → new) / our `CustomerAttribution.firstOrderId` |

### 2a. `order_type` marker — effort: S–M (~0.5–1 day)

**What.** Every order into GA4 carries `subscription_checkout` (first subscription order), `renewal`
(recurring), or `one_off` (no subscription line).

**How.**
- **Preferred:** read Recharge's `subscription_order_type` (`checkout_subscription` → `subscription_checkout`,
  `recurring_subscription` → `renewal`) from the Shopify order's `tags` / `note_attributes`. **Needs a 30-min
  check of a real Naturaw order payload** — Recharge's export carries it, but confirm the Shopify *webhook*
  does too (`noteAttr()` already reads note_attributes).
- **Fallback (always available):** `one_off` when `orderHasSubscription()` is false; otherwise
  `subscription_checkout` when it is the customer's first subscription order (we already learn
  `CustomerAttribution.firstOrderId`), else `renewal`.
- Emit on `buildSubscriptionEvent` **and** `buildOrderPurchaseEvent` (subscription.js), on both the live
  `orders/paid` path and the cron backstop, and mirror in the backfill.

**Done.** Every subscription/renewal order into GA4 carries `order_type`; one-off orders carry `one_off`
(depends on 2b's coverage of the one-off path — see below).

### 2b. `customer_type` (new/returning), extended to ALL orders — effort: M–L (~1.5–2 days incl. reporting)

**What.** Every order — subscription **and** one-off — carries `customer_type: new | returning`, so GA4 shows
new-customer acquisition by channel/campaign exactly as it will for new subscribers.

**Why this is the larger item (the honest sizing driver).** Renewals and subscription orders already flow
through our **server-side** path, where we hold the full Shopify order (so `orders_count` and Recharge fields
are available). **One-off storefront orders do not** — their GA4 purchase is relayed from the client-side web
pixel, which does **not** know `orders_count`. To tag one-off orders reliably we must **enrich them
server-side**: derive `customer_type` on the `orders/paid` webhook (which sees `customer.orders_count`) and
carry it onto the server-relayed purchase, deduped against the pixel on `transaction_id` so nothing
double-counts. That enrichment path — not the flag itself — is the work.

**How.**
- Derive `customer_type` on `orders/paid`: `new` when `customer.orders_count === 1` (this order is their
  first), else `returning`; fall back to our `CustomerAttribution.firstOrderId` if `orders_count` is absent.
- Ensure the GA4 purchase for **one-off** orders carries both params via the server enrichment above.
- **Reporting to match:** app-side report split by `order_type` × `customer_type` × channel/campaign
  (extends the Attribution report). In **GA4**, `order_type` and `customer_type` must be registered as
  **event-scoped custom dimensions** — that is an Equaliser GA4-admin step, not app work (flag it).

**Done.** Every order into GA4 carries both attributes; the app report splits new/returning ×
subscription/renewal/one-off by channel and campaign.

### Quote summary (effort → apply day rate)

| Item                                   | Effort            |
|----------------------------------------|-------------------|
| 2a `order_type` marker                 | S–M · ~0.5–1 day  |
| 2b `customer_type` + one-off coverage  | M–L · ~1.5–2 days |
| Reporting to match (app-side split)    | included in 2b    |
| **Combined 2a + 2b**                   | **~2–3 days**     |

Dependencies before quoting/starting: the 30-min Recharge-payload check (2a), and Equaliser registering the
two GA4 custom dimensions (theirs, not ours). Neither is app-build effort.

---

## Part 3 — Parked (client's decision)

Selectable **date range** and **CSV export** (CAC spec items 3 & 4). The client will work from GA4 directly if
the reporting lands, so these are **parked, not cancelled** — the app-side data model already supports both
(daily rows), so they remain a fast follow if GA4 proves insufficient. No work now.

---

## Out of scope / needs the client

- **GA4 custom dimensions** for `order_type` / `customer_type` — Equaliser GA4-admin step.
- **Recharge field confirmation** on a real order payload — 30 min, blocks 2a's preferred route (fallback
  works regardless).
- **First-party subdomain** (DNS CNAME) — the structural remediation the Part-1 diagnosis will point to for
  the in-app-browser losses; separate quote.
- **UTM conventions** (`Facebook_Mobile_Feed / paid` mis-buckets in GA4) — Equaliser ad-ops change; our own
  channel-group classifier already handles it, but GA4's native channel grouping won't without aligned UTMs.
