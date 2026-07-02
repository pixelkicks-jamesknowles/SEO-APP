// Admin-API subscription resolution. The REST orders/paid payload carries NO selling-plan data on
// line items, so both "is this a subscription order?" and the cadence must come from the Admin API.
// All functions are best-effort: any failure returns empty so the caller treats the order as
// non-subscription rather than crashing the webhook.
import { unauthenticated } from "../shopify.server";

const ORDER_SUBS_QUERY = `#graphql
  query OrderSubs($id: ID!) {
    order(id: $id) {
      lineItems(first: 250) {
        nodes { id sellingPlan { name sellingPlanId } }
      }
    }
  }`;

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

const numId = (gid) => (gid == null ? null : String(gid).match(/\d+/g)?.pop() || null);

/** Resolve subscription intervals (days) for selling-plan ids via the Admin API.
 *  Returns { [numericId]: days }; unresolved ids are omitted (caller falls back to name-parsing).
 *  Pass an existing `admin` client to avoid loading the offline session twice. */
export async function resolveIntervalDays(shop, sellingPlanIds, { monthDays = 28, admin } = {}) {
  const ids = [...new Set((sellingPlanIds || []).filter(Boolean).map(String))];
  if (!ids.length) return {};
  const out = {};
  try {
    const client = admin || (await unauthenticated.admin(shop)).admin;
    const gids = ids.map((id) => (id.startsWith("gid://") ? id : `gid://shopify/SellingPlan/${id}`));
    const res = await client.graphql(PLAN_QUERY, { variables: { ids: gids } });
    const json = await res.json();
    // TEMP DEBUG: reveal exactly what the delivery-policy lookup returns for third-party plans
    // (Kaching/Recharge). Remove once subscription_interval resolves correctly.
    console.warn("[subscription][debug] resolveIntervalDays gids:", gids, "raw:", JSON.stringify(json?.data ?? json?.errors ?? json));
    for (const node of json?.data?.nodes || []) {
      const dp = node?.deliveryPolicy;
      if (!node?.id || !dp?.interval) continue;
      const per = { DAY: 1, WEEK: 7, MONTH: monthDays, YEAR: 365 }[dp.interval] || 0;
      const days = per * (Number(dp.intervalCount) || 1);
      const numeric = numId(node.id);
      if (days > 0 && numeric) out[numeric] = days;
    }
  } catch (e) {
    // best-effort — leave unresolved so the builder falls back to name-parsing
    console.warn("[subscription][debug] resolveIntervalDays threw:", e?.message || e);
  }
  return out;
}

/** Fetch which of an order's line items are subscriptions + their cadence. REST payloads omit this,
 *  so it's the authoritative source. Returns { planByLineId: { [lineItemId]: { id, name } },
 *  intervals: { [planId]: days } }. Empty on any failure → caller treats the order as non-subscription. */
export async function fetchOrderSubscriptions(shop, orderId, { monthDays = 28 } = {}) {
  const empty = { planByLineId: {}, intervals: {} };
  if (!orderId) return empty;
  try {
    const { admin } = await unauthenticated.admin(shop);
    const gid = String(orderId).startsWith("gid://") ? String(orderId) : `gid://shopify/Order/${orderId}`;
    const res = await admin.graphql(ORDER_SUBS_QUERY, { variables: { id: gid } });
    const json = await res.json();
    const nodes = json?.data?.order?.lineItems?.nodes || [];
    const planByLineId = {};
    const planIds = [];
    for (const n of nodes) {
      const sp = n?.sellingPlan;
      const lineId = numId(n?.id);
      if (!sp || !lineId) continue;
      const planId = numId(sp.sellingPlanId);
      planByLineId[lineId] = { id: planId, name: sp.name || "" };
      if (planId) planIds.push(planId);
    }
    const intervals = await resolveIntervalDays(shop, planIds, { monthDays, admin });
    // TEMP DEBUG: shows whether the order line even carries a sellingPlanId (null → delivery-policy
    // lookup is skipped and we fall back to name-parsing). Remove once interval resolves.
    console.warn("[subscription][debug] fetchOrderSubscriptions planByLineId:", JSON.stringify(planByLineId), "intervals:", JSON.stringify(intervals));
    return { planByLineId, intervals };
  } catch (e) {
    // Surface this — a failure here means we can't detect subscriptions, so the webhook skips the
    // order and it silently looks like "no events". Common causes: no offline session, missing scope.
    console.warn("[subscription] Admin order lookup failed:", e?.message || e);
    return empty;
  }
}
