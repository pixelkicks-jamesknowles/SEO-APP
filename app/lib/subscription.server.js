// Admin-API resolution of subscription cadence — the reliable interval source (name-parsing in
// subscription.js is only a fallback). Reads each selling plan's delivery policy via the Admin API,
// so it works regardless of how the merchant named the plan. Best-effort: any lookup failure leaves
// the id unresolved and the caller falls back to parseIntervalDays.
import { unauthenticated } from "../shopify.server";

const PLAN_QUERY = `#graphql
  query PlanIntervals($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on SellingPlan {
        id
        deliveryPolicy {
          ... on SellingPlanRecurringDeliveryPolicy { interval intervalCount }
        }
      }
    }
  }`;

/** Resolve subscription intervals (in days) for a set of selling-plan ids.
 *  Returns { [numericId]: days }; ids that fail or aren't recurring are omitted (caller falls back).
 *  monthDays converts MONTH cadence → days (client default 28). */
export async function resolveIntervalDays(shop, sellingPlanIds, { monthDays = 28 } = {}) {
  const ids = [...new Set((sellingPlanIds || []).filter(Boolean).map(String))];
  if (!ids.length) return {};
  const out = {};
  try {
    const { admin } = await unauthenticated.admin(shop);
    const gids = ids.map((id) => (id.startsWith("gid://") ? id : `gid://shopify/SellingPlan/${id}`));
    const res = await admin.graphql(PLAN_QUERY, { variables: { ids: gids } });
    const json = await res.json();
    for (const node of json?.data?.nodes || []) {
      const dp = node?.deliveryPolicy;
      if (!node?.id || !dp?.interval) continue;
      const per = { DAY: 1, WEEK: 7, MONTH: monthDays, YEAR: 365 }[dp.interval] || 0;
      const days = per * (Number(dp.intervalCount) || 1);
      const numeric = node.id.match(/\d+/g)?.pop();
      if (days > 0 && numeric) out[numeric] = days;
    }
  } catch {
    /* best-effort — leave unresolved so the builder falls back to name-parsing */
  }
  return out;
}
