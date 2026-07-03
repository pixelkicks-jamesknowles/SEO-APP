// Billing scaffolding — DEFINED, NOT ENFORCED.
//
// The app ships free: every feature is available to every install. This module defines a "Pro" plan and
// the plumbing to gate on it later WITHOUT changing today's behaviour. `hasProAccess` deliberately
// returns unlimited access right now, so wiring it into a route is a safe no-op. When you decide to
// charge, flip ENFORCE_BILLING to true (or set BILLING_ENFORCED=true in env) and the same call starts
// requiring an active subscription via the Shopify Billing API — no route code changes needed.
//
// The PRO_PLAN entry is also exported as `billingConfig` and passed to shopifyApp() so Shopify knows the
// plan exists; defining it does not gate anything until a route actually calls `billing.require`.

export const PRO_PLAN = "Pro";

// Passed to shopifyApp({ billing }). One recurring plan, 14-day trial. Amounts are easy to change here.
export const billingConfig = {
  [PRO_PLAN]: {
    lineItems: [
      {
        amount: 19.99,
        currencyCode: "USD",
        interval: "EVERY_30_DAYS",
      },
    ],
    trialDays: 14,
  },
};

// Master switch. Kept false so the app stays free until a pricing decision is made.
const ENFORCE_BILLING = process.env.BILLING_ENFORCED === "true";

/**
 * Whether this shop may use Pro features. TODAY: always unlimited (billing not enforced) — callers can
 * gate features on this now and nothing changes for existing installs. LATER (ENFORCE_BILLING on): checks
 * for an active Pro subscription via the Billing API attached to `authenticate.admin`.
 *
 * @param {object} billing - the `billing` helper from `await authenticate.admin(request)`.
 */
export async function hasProAccess(billing) {
  if (!ENFORCE_BILLING) return { active: true, enforced: false, plan: "free-unlimited" };
  try {
    const check = await billing.check({ plans: [PRO_PLAN], isTest: process.env.NODE_ENV !== "production" });
    return { active: check.hasActivePayment, enforced: true, plan: check.hasActivePayment ? PRO_PLAN : "free" };
  } catch {
    // Never hard-fail a page load on a billing lookup error — treat as no access when enforced.
    return { active: false, enforced: true, plan: "free" };
  }
}

/**
 * Gate a Pro-only route. No-op while billing is unenforced. When enforced and the shop has no active
 * subscription, redirects to the managed pricing / confirmation page. Import and call at the top of a
 * loader/action once you decide a feature is Pro-only.
 */
export async function requirePro(billing) {
  if (!ENFORCE_BILLING) return; // free app — nothing to require yet
  await billing.require({
    plans: [PRO_PLAN],
    isTest: process.env.NODE_ENV !== "production",
    onFailure: async () => billing.request({ plan: PRO_PLAN, isTest: process.env.NODE_ENV !== "production" }),
  });
}
