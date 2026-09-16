// "Why is this purchase Unassigned?" — takes a REAL recent order and asks GA4 what it thinks of the exact
// payload we would send for it.
//
// WHY THIS EXISTS. The consent audit established that capture works: 61% of subscription checkouts carry
// both ga_client_id AND ga_session_id, at identical rates, so neither consent nor a measurement-ID mismatch
// explains why GA4 files those sales under Unassigned. Reading the send path confirms both ids and the real
// timestamp are threaded through. That exhausts what can be learned by reading code — the remaining
// question is whether GA4 ACCEPTS the session join, and only GA4 can answer that.
//
// /debug/mp/collect validates without ingesting, so this creates no conversions and is safe against
// production credentials.
import { validateGa4Payload } from "./server-side.server";

// Newest-first, and only orders that actually carry the ids — an order without them proves nothing about
// the session join, which is the thing under test.
const RECENT_ORDER_QUERY = `#graphql
  query Ga4Diagnose($query: String) {
    orders(first: 25, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customAttributes { key value }
      }
    }
  }`;

const attr = (node, key) => (node?.customAttributes || []).find((a) => a?.key === key)?.value || null;

/** Numeric order id out of a GID, matching numericId() in server-side.server. */
const numeric = (gid) => String(gid ?? "").match(/\d+(?!.*\d)/)?.[0] || null;

/**
 * Find the most recent order carrying BOTH GA ids, rebuild the purchase payload for it, and ask GA4's
 * debug endpoint to validate it. Returns the order it picked, GA4's verbatim messages, and the body sent,
 * so the payload can be inspected rather than assumed.
 */
export async function diagnoseGa4Attribution(admin, settings, { days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  let nodes = [];
  try {
    const res = await admin.graphql(RECENT_ORDER_QUERY, { variables: { query: `created_at:>=${since} financial_status:paid` } });
    const body = await res.json();
    if (!body?.data?.orders) return { error: body?.errors?.[0]?.message || "Could not read recent orders." };
    nodes = body.data.orders.nodes || [];
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 200) };
  }

  const order = nodes.find((n) => attr(n, "ga_client_id") && attr(n, "ga_session_id"));
  if (!order) {
    return {
      error:
        `No order in the last ${days} days carries both a GA client id and session id, so there is nothing to test the ` +
        "session join with. Widen the window, or check the theme embed is live.",
    };
  }

  const clientId = attr(order, "ga_client_id");
  const sessionId = attr(order, "ga_session_id");
  const money = order.currentTotalPriceSet?.shopMoney || {};
  // A purchase event shaped like the one the order paths actually send. Deliberately minimal — items and
  // value modes are irrelevant to whether GA4 honours the session join, and keeping it small makes the
  // returned body readable.
  const params = {
    transaction_id: numeric(order.id),
    value: Number(money.amount) || 0,
    currency: money.currencyCode || "GBP",
  };
  const timestampMicros = order.createdAt ? String(new Date(order.createdAt).getTime() * 1000) : undefined;

  const result = await validateGa4Payload(settings, { name: "purchase", params, clientId, sessionId, timestampMicros });

  // How stale the session was by the time we stamped the event. GA4 will not join an event to a session
  // that had already ended, and a subscription checkout that detours through a hosted checkout can take
  // long enough for that to happen — so surface the gap rather than leave it invisible.
  const sessionStartMs = Number(sessionId) * 1000;
  const orderMs = order.createdAt ? new Date(order.createdAt).getTime() : NaN;
  const minutesAfterSessionStart =
    Number.isFinite(sessionStartMs) && Number.isFinite(orderMs) && sessionStartMs > 0
      ? Math.round((orderMs - sessionStartMs) / 60000)
      : null;

  return {
    order: { name: order.name, createdAt: order.createdAt },
    clientId,
    sessionId,
    minutesAfterSessionStart,
    ...result,
  };
}
