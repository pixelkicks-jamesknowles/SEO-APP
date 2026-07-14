// Pure logic for the historical revenue-by-channel backfill (no IO — unit-tested).
//
// The problem it solves: ChannelRevenueDaily only fills from `orders/paid` going forward, so the
// Attribution report starts empty. Worse, a subscription business's most valuable question — "which
// channel acquired the subscribers whose renewals are paying us now?" — is answered by orders that were
// placed long before the app was installed.
//
// Where the channel comes from: Shopify already computes it. Order.customerJourneySummary.firstVisit
// carries the visit that STARTED the journey (utmParameters, else the source/referrer). We don't have to
// reconstruct attribution — we just have to read it, and replay it onto the renewals that have no journey
// of their own.
//
// Honesty rule: an order whose channel we genuinely cannot determine goes to "(unattributed)", NEVER to
// "(direct)". Folding unknowns into direct would silently inflate the best-looking channel and mislead
// exactly the person reading this report.

export const UNATTRIBUTED = "(unattributed)";

// Data-migration tools create orders in bulk with no customer journey — the acquiring visit happened on the
// PREVIOUS platform, which Shopify never saw. Such an order being unattributed is expected and permanent, so
// we flag it separately from a genuinely lost order (one placed on the store that somehow carries no
// journey). Lets the report say "most of the bucket is your imported back-catalogue, not broken tracking".
const IMPORT_SOURCES = /matrixify|transporter|litextension|cart2cart|next-cart|import/i;

/** True if the order looks like it was created by a store-migration/import tool (from its Source). */
export function isMigratedSource(source) {
  return !!source && IMPORT_SOURCES.test(source);
}

/** Referrer host → a coarse source, so a journey with a referrer but no UTMs still lands somewhere real. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The acquisition channel for ONE order, from Shopify's own customer journey.
 *   1. firstVisit.utmParameters  → the campaign that started the journey (best)
 *   2. firstVisit.source         → Shopify's own classification (e.g. "google", "facebook")
 *   3. firstVisit.referrerUrl    → host as source, medium "referral"
 *   4. null                      → unknowable (caller buckets as (unattributed))
 * Returns { source, medium, campaign } | null.
 */
export function channelFromJourney(journey) {
  const fv = journey?.firstVisit;
  if (!fv) return null;

  const utm = fv.utmParameters;
  if (utm?.source || utm?.medium) {
    return { source: utm.source || null, medium: utm.medium || null, campaign: utm.campaign || null };
  }
  if (fv.source) {
    // Shopify classifies the visit's source; it has no medium, so mark it as referral-grade traffic
    // rather than inventing one.
    return { source: fv.source, medium: "referral", campaign: null };
  }
  const host = hostOf(fv.referrerUrl);
  if (host) return { source: host, medium: "referral", campaign: null };
  return null;
}

/** True if any line on the order carries a selling plan (i.e. it's subscription revenue). */
export function orderIsSubscription(order) {
  return (order?.lineItems || []).some((l) => !!l?.sellingPlan);
}

/** Numeric id out of a Shopify GID ("gid://shopify/Customer/123" → "123"), else the value as-is. */
export function numericGid(gid) {
  if (gid == null) return null;
  const s = String(gid);
  return s.match(/\d+(?!.*\d)/)?.[0] || s || null;
}

/**
 * A stable key for the customer, or null for a guest.
 *
 * MUST match attribution.js `customerKey()`, which the live orders/paid path uses to look these rows back
 * up: the webhook delivers a REST-style NUMERIC customer id ("9539392930134"), while GraphQL returns a GID
 * ("gid://shopify/Customer/9539392930134"). Seeding the GID would write CustomerAttribution rows the live
 * path could never find — the backfill would look like it worked and quietly do nothing.
 */
export function orderCustomerKey(order) {
  const id = order?.customer?.id;
  return id ? numericGid(id) : null;
}

const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : null);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Fold a page of orders (ASCENDING by createdAt) into daily per-channel revenue, replaying each
 * customer's FIRST-TOUCH channel onto their later orders — which is the only way a renewal gets a channel
 * at all (it has no journey of its own; there was no visit).
 *
 * `firstTouch` is a mutable Map(customerKey → {source,medium,campaign}) carried ACROSS pages: because we
 * page oldest-first, the first time we see a customer is their earliest order, so whatever journey that
 * order carries IS their first touch. Later orders (renewals) inherit it. The caller persists this map to
 * CustomerAttribution, which also fixes attribution for renewals arriving in future.
 *
 * Returns { rows, firstTouch, learned } — rows keyed by date+source+medium, ready to increment.
 */
/**
 * `revenueSince` (YYYY-MM-DD) splits the two windows this backfill deliberately keeps separate:
 *
 *   • FIRST TOUCH is learned from the ENTIRE order history. An established subscriber's *acquiring* order —
 *     the only one that ever carried a customer journey — is often a year or more old. If we only look at
 *     the reporting window we never see it, never learn their channel, and every renewal they've paid since
 *     falls into (unattributed). That was 79% of Naturaw's unattributed revenue.
 *   • REVENUE is only aggregated for dates >= revenueSince, because that's the window the report shows.
 *
 * So an old order can teach us a customer's channel while contributing no revenue row of its own.
 */
export function foldOrders(orders = [], firstTouch = new Map(), { revenueSince = null } = {}) {
  const rows = new Map();
  const learned = [];
  // Diagnostic for the (unattributed) bucket. Without this, someone reading the report WILL assume the
  // unknowns are organic (or direct) — the two most flattering guesses — and there'd be nothing to stop
  // them. These counters say plainly WHY we don't know.
  const unattributed = emptyUnattributed();
  // The individual orders in that bucket, so the report can list/export them and split migrated-in from
  // genuinely lost. Windowed exactly like the counters (only orders >= revenueSince land here).
  const unattributedOrders = [];
  // Per-customer lifetime deltas for THIS page — counts EVERY scanned order (all history), NOT just the
  // revenue window, because LTV is a lifetime figure. Aggregated per customer so the caller does one write.
  const lifetime = new Map();

  for (const order of orders) {
    const date = dayOf(order?.createdAt);
    if (!date) continue;

    const key = orderCustomerKey(order);

    // Lifetime accumulation happens for every scanned order, before the revenue-window gate below.
    if (key) {
      const lt = lifetime.get(key) || { revenueDelta: 0, orderDelta: 0, firstOrderAt: date, lastOrderAt: date };
      lt.revenueDelta = round2(lt.revenueDelta + (Number(order?.totalPrice) || 0));
      lt.orderDelta += 1;
      if (date < lt.firstOrderAt) lt.firstOrderAt = date;
      if (date > lt.lastOrderAt) lt.lastOrderAt = date;
      lifetime.set(key, lt);
    }

    // The channel this order can see for itself (a renewal sees nothing).
    const own = channelFromJourney(order?.customerJourneySummary);

    let ch = null;
    if (key) {
      if (!firstTouch.has(key) && own) {
        // Earliest order we've seen for this customer AND it carries a journey → this is their first touch.
        firstTouch.set(key, own);
        // firstOrderId numeric too, matching what the live pipeline stores.
        learned.push({ customerKey: key, ...own, firstOrderId: numericGid(order?.id) });
      }
      ch = firstTouch.get(key) || own;
    } else {
      ch = own; // guest checkout: only its own journey is available
    }

    // Older than the reporting window: it has done its job (taught us this customer's first touch above)
    // and must NOT contribute revenue, or we'd inflate the report with history it doesn't cover.
    if (revenueSince && date < revenueSince) continue;

    const source = ch?.source || UNATTRIBUTED;
    const medium = ch?.medium || "(none)";
    const revenue = Number(order?.totalPrice) || 0;
    const isSub = orderIsSubscription(order);

    if (source === UNATTRIBUTED) {
      unattributed.orders += 1;
      unattributed.revenue += revenue;
      if (isSub) {
        // A renewal with no channel: neither this order NOR the customer's acquiring order carried a
        // journey. Usually a subscriber migrated in, or acquired before journeys were captured.
        unattributed.subscriptionOrders += 1;
        unattributed.subscriptionRevenue += revenue;
      }
      if (key) unattributed.knownCustomerNoJourney += 1;
      else unattributed.guestNoJourney += 1;
      if (!unattributed.oldest || date < unattributed.oldest) unattributed.oldest = date;
      if (!unattributed.newest || date > unattributed.newest) unattributed.newest = date;

      const migrated = isMigratedSource(order?.source);
      if (migrated) unattributed.migratedOrders += 1;
      unattributedOrders.push({
        orderId: numericGid(order?.id),
        name: order?.name || null,
        date,
        revenue: round2(revenue),
        isSubscription: isSub,
        source: order?.source || null,
        migrated,
        // Why we can't attribute it — the two are meaningfully different to whoever reads the export.
        reason: key ? "known_customer_no_journey" : "guest_no_journey",
        customerKey: key,
      });
    }

    const rk = `${date}|${source}|${medium}`;
    const agg = rows.get(rk) || { date, source, medium, orders: 0, revenue: 0, subscriptionOrders: 0, subscriptionRevenue: 0 };
    agg.orders += 1;
    agg.revenue += revenue;
    if (isSub) {
      agg.subscriptionOrders += 1;
      agg.subscriptionRevenue += revenue;
    }
    rows.set(rk, agg);
  }

  const out = [...rows.values()].map((r) => ({
    ...r,
    revenue: round2(r.revenue),
    subscriptionRevenue: round2(r.subscriptionRevenue),
  }));
  unattributed.revenue = round2(unattributed.revenue);
  unattributed.subscriptionRevenue = round2(unattributed.subscriptionRevenue);
  const lifetimeUpdates = [...lifetime.entries()].map(([customerKey, v]) => ({ customerKey, ...v }));
  return { rows: out, firstTouch, learned, unattributed, unattributedOrders, lifetimeUpdates };
}

export function emptyUnattributed() {
  return {
    orders: 0,
    revenue: 0,
    subscriptionOrders: 0,
    subscriptionRevenue: 0,
    // Shopify recorded no journey AND we found no acquiring order for this customer (migrated subscriber,
    // API-created order, or acquired before journeys were captured).
    knownCustomerNoJourney: 0,
    // No customer on the order at all (guest / POS / draft) and no journey either.
    guestNoJourney: 0,
    // Subset created by a store-migration tool — expected to be unattributable (acquired on the old
    // platform). Splitting this out lets the report distinguish "imported back-catalogue" from "lost".
    migratedOrders: 0,
    oldest: null,
    newest: null,
  };
}

/** Merge two unattributed summaries — the backfill pages across ticks, so these accumulate. Pure. */
export function mergeUnattributed(a, b) {
  const x = { ...emptyUnattributed(), ...(a || {}) };
  const y = { ...emptyUnattributed(), ...(b || {}) };
  const minDate = (p, q) => (!p ? q : !q ? p : p < q ? p : q);
  const maxDate = (p, q) => (!p ? q : !q ? p : p > q ? p : q);
  return {
    orders: x.orders + y.orders,
    revenue: round2(x.revenue + y.revenue),
    subscriptionOrders: x.subscriptionOrders + y.subscriptionOrders,
    subscriptionRevenue: round2(x.subscriptionRevenue + y.subscriptionRevenue),
    knownCustomerNoJourney: x.knownCustomerNoJourney + y.knownCustomerNoJourney,
    guestNoJourney: x.guestNoJourney + y.guestNoJourney,
    migratedOrders: x.migratedOrders + y.migratedOrders,
    oldest: minDate(x.oldest, y.oldest),
    newest: maxDate(x.newest, y.newest),
  };
}
