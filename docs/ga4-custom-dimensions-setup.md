# GA4 setup required: two custom dimensions

**Who this is for:** whoever administers the Naturaw GA4 property (Equaliser).
**Time needed:** about five minutes in GA4 Admin. No code, no tag changes, no developer involvement.

## What we need you to do

Register two **event-scoped custom dimensions** in the Naturaw GA4 property:

| Dimension name | Scope | Event parameter | Values it will contain |
|---|---|---|---|
| `order_type` | Event | `order_type` | `subscription_checkout`, `renewal`, `reactivation`, `one_off` |
| `customer_type` | Event | `customer_type` | `new`, `returning` |

**GA4 Admin → Data display → Custom definitions → Create custom dimension.** Set *Scope* to **Event** and
*Event parameter* to the exact strings above. The dimension name and the parameter name must match exactly
— GA4 will not warn you if they don't, the dimension simply stays empty.

## Why it matters

Every Naturaw order already carries both parameters. They reach GA4 today and are visible in **Realtime**
and **DebugView** right now.

But GA4 will not let you group or filter by a custom parameter in **standard reports or Explore** until it
is registered as a custom dimension. Until that is done:

- you cannot break new subscribers out from renewals,
- you cannot break new customers out from returning ones,
- neither is available by channel or campaign,

and the reporting will look as though it was never built. The data is arriving; GA4 just won't surface it.

## Two things to know before you start

1. **It takes 24–48 hours** for a newly registered dimension to start appearing in standard reports.
2. **It is not retroactive.** GA4 only applies the dimension to events received *after* registration.
   Events already collected stay ungrouped permanently. This is the reason to do it sooner rather than
   later — every day it waits is a day of data that can never be broken down this way.

## How to check it worked

Immediately after registering, open **Realtime** and confirm both parameters appear on a `purchase` event.
Then after 24–48 hours, open any standard event report or an Explore and confirm `order_type` and
`customer_type` are selectable as dimensions.

Expected once live: `renewal` will dominate by volume (a subscription business bills far more often than it
acquires), with `subscription_checkout` marking genuinely new subscribers and `one_off` covering
non-subscription purchases. `reactivation` marks a lapsed subscriber who returned — it is inferred from the
gap since their last subscription order against its billing cadence, so treat it as indicative rather than
exact. A paused subscription that resumes looks the same as one that was cancelled and restarted.

## Also worth registering while you are in there

Not required for the above, but these parameters are already being sent and are useful:

`subscription_interval`, `subscription`, `first_source`, `last_source`, `last_medium`, `last_campaign`,
`touch_count`, and — if margin or multi-currency mode is enabled — `revenue`, `original_value`,
`original_currency`.
