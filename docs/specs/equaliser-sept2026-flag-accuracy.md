# Spec: Equaliser Sept 2026 — new vs renewal / new customer, accuracy follow-up

Planning artifact for the two items in Chris's email of Sept 2026:

1. **New v renewal going into GA4**
2. **New customer tracking**

> ## ⚠️ Headline: both items are ALREADY BUILT AND SHIPPED
>
> They were specced as Part 2 of [equaliser-aug2026-requests.md](equaliser-aug2026-requests.md) and
> implemented on **2026-08-10** (commit `af07f21`). `order_type` and `customer_type` ride every order's
> GA4 events today, on every path, with an app-side report to match.
>
> **This is not new scope.** What follows is an audit of what is actually live, three accuracy defects
> found in the delivered feature, and a recommendation for how to spend the quoted day.

> ## ✅ Status update (2026-09-13) — all of Part 2 and Part 3 are now BUILT
>
> Every defect in Part 2 is fixed and reactivation (Part 3) is implemented on the heuristic route, along
> with the paid-attribution work that stops Google/Meta orders being recorded as direct. Still unshipped
> (uncommitted) and still dependent on the client actions listed at the bottom. What remains genuinely
> outstanding:
>
> - ~~**The Recharge payload check (2c)**~~ — **DONE 2026-09-14. Verdict: the classifiers are correct on
>   real Naturaw data.** Ten consecutive live orders were run through the shipped `orderTypeOf` /
>   `customerTypeOf`; all ten classified correctly, including a customer with **30 prior orders placing
>   their first subscription** (`#NATS0295003` → `subscription_checkout`/`returning`), which naive
>   `orders_count > 1` logic would have called a renewal. What the payload actually carries:
>     - `subscription_order_type` note attribute: **absent**. The "preferred route" does not exist on this
>       store — the **tag fallback is what carries it**, and Naturaw's tags (`Subscription Recurring Order`,
>       `Subscription First Order`) match our patterns exactly.
>     - Shopify **selling plans are present** on subscription lines, so the primary line-item route works
>       too — the two routes are genuinely belt-and-braces here, not one propping up the other.
>     - `customer.numberOfOrders` is populated in GraphQL. NOTE this does **not** prove REST
>       `customer.orders_count` (deprecated) is in the webhook body, so `customer_type` now falls back to
>       an Admin lookup when the payload can't answer — see below.
> - **Contract-level reactivation** — the heuristic shipped instead; it cannot tell a PAUSE from a
>   cancel-and-restart. Upgrading needs Shopify `subscription_contracts/*` or the Recharge API (4-6 days).
> - **GA4 custom dimensions** — Equaliser's own admin step; nothing is visible to them until it is done.
>   Hand them [`docs/ga4-custom-dimensions-setup.md`](../ga4-custom-dimensions-setup.md) — it is written for
>   their GA4 admin and covers the exact names, the event scope, and the two properties that catch people
>   out (24-48h lag, and it is NOT retroactive, so every day it waits is data that can never be grouped).

---

## Part 1 — What is already live (audit)

Both attributes are emitted on **every** order path, not just the subscription one:

| GA4 event param | Values | Source of truth |
|---|---|---|
| `order_type` | `subscription_checkout` \| `renewal` \| `one_off` | Recharge `subscription_order_type` marker, else line-item selling-plan scan |
| `customer_type` | `new` \| `returning` | Shopify `customer.orders_count` (`== 1` → new), else `CustomerAttribution.firstOrderId`, else an Admin `customer.numberOfOrders` lookup (added 2026-09-14, because `orders_count` is deprecated on the REST Customer resource and may be absent from the webhook body) |

Coverage, verified in code:

| Path | Where | Status |
|---|---|---|
| Subscription orders (live + cron backstop) | `subscription-cron.server.js:130-132` | ✅ |
| One-off storefront purchases | `ingest.server.js:97-106` via Admin classify | ✅ |
| Reconcile backfill (orders the pixel missed) | `reconcile.server.js:105-107` | ✅ |
| Shopify order/customer metafields (native reporting) | `report-writeback.server.js:27-28` | ✅ |
| Historical metafield backfill | `metafield-backfill.server.js:153-154` | ✅ |
| App-side report, split by channel × campaign | `attribution-report.js:249-270` | ✅ |

**Still outstanding on Equaliser's side, not ours:** `order_type` and `customer_type` must be registered
as **event-scoped custom dimensions** in GA4 Admin. Until that is done the params arrive but are not
reportable, so the feature will look like it is not working. This was flagged as a dependency in the Aug
spec and should be confirmed before any further work is quoted.

---

## Part 2 — Three accuracy defects in the delivered feature

All three confirmed by executable test against the live code, not inferred by reading.

### 2a. `isFirstSubscriptionOrder` is fed the customer's first order of ANY kind

**The defect.** `orderTypeOf(order, { isFirstSubscriptionOrder })` ([subscription.js:79-86](../../app/lib/subscription.js))
expects "is this their first *subscription* order". Every one of the four call sites passes `isFirstOrder`,
derived from `customer.orders_count === 1` — their first order of *any* kind:

- `webhooks.orders.paid.jsx:47`
- `subscription-cron.server.js:130`
- `report-writeback.server.js:196`
- `metafield-backfill.server.js:153`

**Consequence.** A customer who buys a one-off first and subscribes later has their genuine subscription
checkout labelled **`renewal`**. On a store selling both one-offs and subscriptions, new-subscriber counts
are understated and renewals overstated — the exact number the client is buying this for.

```
order: 1 subscription line, customer.orders_count = 2
  actual   → "renewal"
  expected → "subscription_checkout"
```

**Masked when Recharge's marker is present**, because `rechargeOrderType()` wins before the fallback runs.
So the blast radius depends entirely on whether Recharge's `subscription_order_type` is actually on the
Shopify webhook payload — see 2c.

**Fix.** Track first *subscription* order separately: add `firstSubscriptionOrderId` (or a date) to
`CustomerAttribution`, write it on `orders/paid` when the order has a subscription line and the field is
unset, seed it from the backfill so existing subscribers are correct from day one, and pass that to
`orderTypeOf`. Migration + live write + backfill seed + tests.

**Effort: ~0.5–1 day.**

### 2b. Recharge tag-only renewals are not counted as subscription revenue

**The defect.** Two functions disagree about what a subscription is:

- `orderTypeOf()` detects Recharge via note attribute **or order tags** → correctly returns `renewal`
- `orderHasSubscription()` ([subscription.js:26-28](../../app/lib/subscription.js)) checks **only** for a
  Shopify selling plan on a line

`webhooks.orders.paid.jsx:57` uses the second for `isSubscription` on `recordChannelRevenue`.

**Consequence.** If Recharge runs on its **own checkout** rather than Shopify Checkout Integration, its
renewals carry Recharge tags but no selling plan. The order is labelled `renewal` but recorded with
`subscriptionRevenue: 0`. **Subscription revenue totals would be structurally short against Recharge** —
which is precisely the reconciliation problem the client has raised separately.

```
order: no selling plan, tags "Subscription Recurring Order"
  orderTypeOf()          → "renewal"        ✅
  orderHasSubscription() → false            ❌ revenue not counted as subscription
```

**Fix.** Make `orderHasSubscription()` also accept a Recharge marker. One line plus tests, but check the
other call sites first (`reconcile.server.js:107`, `subscription-cron.server.js`) since it changes what
counts as a subscription across the board.

**Effort: ~2 hours.**

### 2c. The Recharge payload check was a stated dependency and may never have happened

The Aug spec lists as a blocking dependency: *"Needs a 30-min check of a real Naturaw order payload —
Recharge's export carries it, but confirm the Shopify webhook does too."*

Everything in 2a and 2b turns on the answer:

| If the marker IS on the webhook payload | If it is NOT |
|---|---|
| 2a is masked; flags are accurate today | 2a bites on every mixed-basket customer |
| 2b likely fine (Shopify Checkout Integration) | 2b understates subscription revenue |

**This should be done before anything else is built.** It is half an hour and it determines whether the
quoted day is needed at all.

**Effort: ~0.5 day** including pulling real orders and validating end to end in GA4 DebugView.

---

## Part 3 — Reactivation (Dunc's question) — NOT built, genuinely new scope

> *"Does the new vs renewal flag separate a reactivated subscriber from a genuinely new one?"*

**No.** The flag separates first orders from renewals only. A reactivated subscriber reads as:

- **`subscription_checkout`** if Recharge's marker is present — indistinguishable from a genuinely new subscriber
- **`renewal`** if not, because `orders_count > 1`

`customer_type` would say `returning`, but that bucket also holds anyone who ever bought a one-off, so it
is not a reactivation signal.

**Why it cannot be added cheaply.** The app subscribes only to order webhooks (`orders/paid`,
`refunds/create`, `orders/cancelled`, `orders/edited`, `fulfillments/create`) and stores no subscription
state. It has no visibility of a contract being cancelled or restarted. `CustomerLifetime` is written
**only by the backfill** (`backfill.server.js:140`) and wiped on each run, so there is no live per-customer
subscription history to reason from either.

| Route | What it needs | Effort |
|---|---|---|
| **Heuristic** — gap since last subscription order > N × billing interval | New live-maintained field + migration + backfill seed + threading into GA4/metafields/reporting. `resolveIntervalDays` already supplies the cadence. | **2–3 days** |
| **Contract-level** — Shopify `subscription_contracts/*` webhooks, or Recharge API | New scope (merchant re-consent, two-target deploy) or a new Recharge integration | **4–6 days** |

**The catch with the cheap route:** it cannot distinguish a *paused* subscription from a
cancelled-and-restarted one — both are just a gap in order history. Subscription businesses pause a lot, so
if this number needs to be trustworthy rather than indicative, it has to be contract-level.

---

## Recommendation — how to spend the quoted day

The two email items are delivered. The day is better spent making them **accurate** than rebuilding them:

| | Item | Effort |
|---|---|---|
| 1 | Recharge payload check + end-to-end validation (2c) — **do first, it may change the rest** | ~0.5 day |
| 2 | Fix `orderHasSubscription` to accept the Recharge marker (2b) | ~2 hrs |
| 3 | Track first *subscription* order properly (2a) | ~0.5–1 day |

**Total ~1–1.5 days**, fitting the quoted day closely, and it resolves both the new-vs-renewal accuracy
question and the Recharge reconciliation gap in one pass.

**Reactivation (Part 3) sits outside this** and should be quoted separately once the client confirms
whether "indicative" is good enough or it needs to be exact.

---

## Dependencies on the client

1. **Register `order_type` and `customer_type` as event-scoped custom dimensions in GA4 Admin.** Without
   this the data arrives but is not reportable. Blocks them seeing any of the delivered work.
2. **Confirm whether Recharge is on Shopify Checkout Integration.** Determines the severity of 2a and 2b
   and whether contract-level reactivation is even available.
3. **Decide on reactivation:** indicative (heuristic, 2–3 days) or exact (contract-level, 4–6 days).
