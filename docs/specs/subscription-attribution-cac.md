# Spec: subscription attribution → CAC by channel & campaign

Scopes the build proposed in response to the client's (Duncan / Equaliser) 2026-07 review. This doc is the
planning artifact for sizing against the agreed 1-2 day T&M, and for the call.

> **Update (Aug 2026):** superseded/reorganised by
> [equaliser-aug2026-requests.md](equaliser-aug2026-requests.md) after the client's consolidated list. Item 1's
> `subscription_type` marker is now generalised to two attributes (order type + customer type); items 3 & 4
> (date range, CSV export) are **parked** per the client. Read the Aug spec first.

## The goal ("done")

The client can see **which channels and campaigns drive NEW subscribers**, over a **selectable date range**,
in a form they can **export and join to ad spend** — so they can calculate **subscriber CAC by channel and
campaign** and back what's working. Renewal revenue by acquiring channel (which GA4 can't do) stays as-is.

## Root-cause context (not a report feature — the thing underneath)

The review confirmed the pipeline works (orders reconcile within ~1%). The gap is that GA4 shows renewals
**plus roughly half of new subscribers** as Unassigned, because **no browsing session is captured at the
subscription sale** for those. Causes: the Recharge checkout redirect breaks Shopify's own journey
(`shopify.com / referral`), Meta clicks land in the IG/FB in-app browser that blocks the tracking cookie
(Meta reads 1 vs 50+), and — the operational one now fixed — the live `/visit` capture wasn't deployed to the
storefront (`shopify app deploy` had not been run after the visitor-tracking work; Tracked visitors was 0,
now climbing).

The reporting features below make the data **usable**; they do **not** recover journeys that were never
captured. Closing the capture gap going forward is items 5 (subdomain) + the deploy (done) + item 6
(observability).

---

## 1. New-vs-renewal marker on each order → GA4  ·  effort: M (~0.5–1 day)

**Answers:** Duncan's request A. **Priority: high** (unblocks isolating new-subscriber acquisition in GA4).

**What.** Add an explicit `subscription_type` param (`new` | `renewal`) to the subscription event sent to
GA4, and surface the split in the app's own report — instead of inferring "new" from whether a channel is
present. Lets Equaliser filter GA4 to new subscribers only.

**How.**
- Detect new vs renewal. Two routes, pick per what's actually on the order:
  - **Preferred:** read Recharge's `subscription_order_type` (`checkout_subscription` / `recurring_subscription`)
    if Recharge writes it to the Shopify order's `tags` / `note_attributes`. *Needs a 30-min check of a real
    Naturaw order payload — Recharge's export has it, but the Shopify webhook may not.*
  - **Fallback (always available):** infer "new = the customer's first subscription order". The module
    already learns first-touch per customer (`CustomerAttribution.firstOrderId`), so "is this that first
    order?" is a cheap check on the `orders/paid` path.
- Emit the param in `buildSubscriptionEvent` (`subscription.js`), on both the live `orders/paid` path and the
  cron backstop, and mirror the classification in the backfill.
- App report: split subscription counts/revenue by new vs renewal (a counter on `ChannelRevenueDaily`, or
  derived from the per-customer first-order set).

**Caveat (state it plainly to the client).** This is **diagnostic, not a fix.** It lets them *see* the new
subscribers and isolate them; it does **not** recover a channel for the ~54 whose journey wasn't captured —
those stay Unassigned. Its value is clean new-vs-renewal separation from now on.

**Done.** GA4 subscription events carry `subscription_type`; the app report filters/splits new vs renewal.

## 2. Campaign dimension in the report  ·  effort: S–M (counts) / M–L (with revenue)

**Answers:** Duncan's request C (campaign-level join to spend). **Priority: high.**

**What.** Break the subscription/attribution report out by **campaign** (source / medium / campaign), not just
source/medium. The UTM `campaign` is already captured and already sent to GA4 on the subscription event
(`attach()` in `subscription.js`), so on matched sessions GA4 already has Session campaign — this is about the
app's own report.

**How — two tiers:**
- **Tier A (S–M, ~0.5 day): new-subscriber COUNTS by campaign.** `CustomerAttribution.campaign` already
  exists; extend `bySubscriptionSource` to group by campaign. Gives customers-per-campaign, no revenue.
- **Tier B (M–L, ~1 day): REVENUE by campaign.** Add `campaign` to `ChannelRevenueDaily`'s key
  (`shopDomain+date+source+medium+campaign`), write it on the live + backfill paths, surface in the table.
  Schema change + a backfill re-run to populate history.

**Done.** Report shows new subscribers (Tier A) or revenue (Tier B) broken out by campaign.

## 3. Selectable date range  ·  effort: S–M (~0.5 day) + M to extend history

**Answers:** Duncan's "it's fixed to the last 90 days". **Priority: high.**

**What.** Replace the fixed 90-day window with a range control (presets 7/30/90/custom).

**How.** `ChannelRevenueDaily` stores **daily** rows, so an arbitrary range is just a query filter + a Polaris
date picker wired to loader `from`/`to` params — the data model already supports it. **Caveat:** history depth
= the backfill's *revenue* window (currently 90 days). Ranges older than that are empty unless we widen the
revenue window (e.g. to 12 months) — that's a config change + a longer backfill + a bigger table (+M).

**Done.** User picks a range; the whole report (including 1 & 2) reflects it. History depth documented.

## 4. Full data export (CSV)  ·  effort: S–M (~0.5 day)

**Answers:** Duncan's "extract and join to spend". **Priority: high.**

**What.** "Download CSV" of the report for the selected range: channel / campaign / new-vs-renewal / orders /
revenue — the row shape Equaliser joins to spend.

**How.** Reuse the existing CSV resource-route pattern (the unattributed-orders export). Honour the selected
range + campaign breakout.

**Done.** One-click CSV matching what's on screen.

## 5. First-party subdomain (journey-capture hardening)  ·  effort: M–L · needs their DNS

**Answers:** Duncan's "why are journeys missing / can capture improve". Already scoped in
[first-party-subdomain.md](first-party-subdomain.md). This is what makes the durable id ITP-proof and survives
the **in-app browsers** that are losing Meta's new subscribers. Needs a DNS CNAME from the client. Separate
from the reporting quartet; the bigger structural fix.

## 6. Capture observability tile  ·  effort: S (~2–4h)

**What.** A dashboard tile: "last storefront visit received", a rolling count, and durable-id (`pxp_id`) mint
success rate — so capture health is a number you can point at, not a DevTools investigation. Directly useful
for the call (proves the deploy fix is live) and ongoing (spots a future regression immediately).

**Done.** Tile on Home/Accuracy shows live capture landing + durable-id health.

---

## Sequencing vs the 1–2 day T&M

The **reporting quartet (1–4)** is what directly answers the CAC ask. Done comprehensively (with revenue-by-
campaign Tier B + history extension) it's ~2.5–3 days. To fit **1–2 days**, the honest MVP is:

1. **New-vs-renewal marker** (item 1) — highest unblock.
2. **Campaign Tier A + date picker + CSV export** (2A, 3, 4) over the existing 90-day data.
3. **Observability tile** (item 6) — cheap, high-confidence-for-the-call.

Deferring to a follow-up (flag on the call): **revenue-by-campaign Tier B** (2B, schema + backfill re-run),
**history >90 days** (widen the revenue window), and the **first-party subdomain** (item 5, needs their DNS).

## Out of scope / needs the client

- **DNS CNAME** for item 5.
- **UTM conventions:** `Facebook_Mobile_Feed / paid` etc. aren't GA4-recognised as Paid Social, so matched
  Meta sessions mis-bucket **in GA4** (our own channel-group classifier already handles them). Aligning the
  UTMs (`utm_source=facebook`, `utm_medium=paid_social`) is an Equaliser ad-ops change, not app work.
