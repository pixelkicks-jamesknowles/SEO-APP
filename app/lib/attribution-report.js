// Pure aggregation for the in-app Attribution report (no IO — unit-tested). Turns the raw
// VisitorAttribution / CustomerAttribution rows (already captured by the tracking pipeline) into the
// summaries the report renders: top first-touch sources, touch-count distribution, first-vs-last-touch
// shift, and subscription first-order sources.

const labelOf = (source, medium) => `${source || "(direct)"} / ${medium || "(none)"}`;

// GA4-style default channel grouping, applied to OUR source/medium data. GA4 doesn't let you send a channel
// group — it derives one by classifying source/medium into buckets (Organic Search, Paid Social, Email, …).
// We reproduce that classification here so the report can roll up by channel group like GA4 does, with two
// deliberate differences: (1) it also covers subscription renewals, which GA4 can never classify (no
// session); (2) our "(unattributed)" stays its own honest bucket rather than being folded into Direct.
// It mirrors GA4's rules and evaluation order closely, but is an approximation — edge cases may differ.
const SEARCH_SOURCES = new Set(["google", "bing", "yahoo", "duckduckgo", "ecosia", "baidu", "yandex", "ask", "aol", "brave", "startpage"]);
const SOCIAL_SOURCES = new Set(["facebook", "fb", "facebook_feed", "facebook_mobile_feed", "instagram", "instagram_feed", "instagram_stories", "ig", "twitter", "x", "t.co", "tiktok", "pinterest", "linkedin", "reddit", "snapchat", "youtube", "whatsapp", "threads"]);
const EMAIL_SOURCES = new Set(["email", "klaviyo", "metorik", "mailchimp", "sendgrid", "omnisend", "dotdigital", "drip"]);
const isPaidMedium = (m) => /^(.*cp.*|ppc|retargeting|paid.*|display)$/.test(m);

/** Classify a source/medium into a GA4-style default channel group. */
export function channelGroupOf(source, medium) {
  const s = String(source || "").toLowerCase();
  const m = String(medium || "").toLowerCase();
  if (s === "(unattributed)") return "(unattributed)"; // kept honest — not folded into Direct/Referral
  // Shopify labels its own direct classification "direct" (we tag it medium "referral"); treat it as Direct.
  if (/^\(?direct\)?$/.test(s) && ["", "(none)", "(not set)", "referral"].includes(m)) return "Direct";
  const search = SEARCH_SOURCES.has(s);
  const social = SOCIAL_SOURCES.has(s);
  const paid = isPaidMedium(m);
  if (paid && search) return "Paid Search";
  if (paid && social) return "Paid Social";
  if (paid) return "Paid Other";
  if (m === "email" || EMAIL_SOURCES.has(s)) return "Email";
  if (social || /^(social|social-network|social-media|sm)$/.test(m)) return "Organic Social";
  if (search || m === "organic") return "Organic Search";
  if (/^(referral|app|link)$/.test(m)) return "Referral";
  return "Unassigned";
}

/** Bare host of a referrer URL (leading www. stripped), or null if unparseable. */
function referrerHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * First-touch source/medium/campaign for a storefront visit. UTMs win; otherwise derive from the referrer
 * host the same way the order-side journey logic does — a search engine host → organic, a social host →
 * social, anything else → that host as a referral. Returns null for a truly direct visit (no UTMs, no
 * external referrer) so the caller records no row and "(direct)" is never invented. Pure.
 *
 * The referrer is expected to already be EXTERNAL (the embed drops same-host referrers, which are internal
 * navigation, before sending) so we don't misread the shop's own domain as a referral source.
 */
export function visitAttribution(utm = null, referrer = null) {
  const source = utm?.utm_source || null;
  const medium = utm?.utm_medium || null;
  const campaign = utm?.utm_campaign || null;
  if (source || medium || campaign) return { source, medium, campaign };
  const host = referrerHost(referrer);
  if (!host) return null;
  const labels = host.split("."); // match a known engine/network anywhere in the host (search.yahoo.com, l.facebook.com)
  const search = labels.find((l) => SEARCH_SOURCES.has(l));
  if (search) return { source: search, medium: "organic", campaign: null };
  const social = labels.find((l) => SOCIAL_SOURCES.has(l));
  if (social) return { source: social, medium: "social", campaign: null };
  return { source: host, medium: "referral", campaign: null };
}

/** Roll ChannelRevenueDaily rows up by GA4-style channel group (subscription split kept), sorted by revenue. */
export function byChannelGroup(rows = []) {
  const map = new Map();
  let totalRevenue = 0;
  for (const r of rows) {
    const group = channelGroupOf(r.source, r.medium);
    const agg = map.get(group) || { group, orders: 0, revenue: 0, subscriptionOrders: 0, subscriptionRevenue: 0 };
    agg.orders += Number(r.orders) || 0;
    agg.revenue += Number(r.revenue) || 0;
    agg.subscriptionOrders += Number(r.subscriptionOrders) || 0;
    agg.subscriptionRevenue += Number(r.subscriptionRevenue) || 0;
    map.set(group, agg);
    totalRevenue += Number(r.revenue) || 0;
  }
  const round = (n) => Math.round(n * 100) / 100;
  return [...map.values()]
    .map((a) => ({
      ...a,
      revenue: round(a.revenue),
      subscriptionRevenue: round(a.subscriptionRevenue),
      oneOffRevenue: round(a.revenue - a.subscriptionRevenue),
      aov: a.orders ? round(a.revenue / a.orders) : 0,
      share: totalRevenue > 0 ? Math.round((a.revenue / totalRevenue) * 100) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

/** Group visitor rows by first-touch source/medium. Returns rows sorted by visitor count desc. */
export function byFirstTouch(rows = []) {
  const map = new Map();
  for (const r of rows) {
    const key = labelOf(r.source, r.medium);
    const agg = map.get(key) || { source: r.source || "(direct)", medium: r.medium || "(none)", visitors: 0, touches: 0 };
    agg.visitors += 1;
    agg.touches += Number(r.visits) || 1;
    map.set(key, agg);
  }
  return [...map.values()].sort((a, b) => b.visitors - a.visitors);
}

/** Histogram of touch counts (a visitor's UTM-tagged visits): buckets 1, 2, 3, 4+. */
export function touchDistribution(rows = []) {
  const buckets = { "1": 0, "2": 0, "3": 0, "4+": 0 };
  for (const r of rows) {
    const v = Number(r.visits) || 1;
    if (v >= 4) buckets["4+"] += 1;
    else buckets[String(v)] += 1;
  }
  return buckets;
}

/** Share of visitors with more than one touch (multi-touch), as a whole percent, or null if no rows. */
export function multiTouchShare(rows = []) {
  if (!rows.length) return null;
  const multi = rows.filter((r) => (Number(r.visits) || 1) > 1).length;
  return Math.round((multi / rows.length) * 100);
}

/** Count of visitors whose latest source differs from their first-touch source (journey shifted). */
export function firstVsLastShift(rows = []) {
  let shifted = 0;
  for (const r of rows) {
    const first = r.source || null;
    const last = r.lastSource ?? first;
    if ((first || "") !== (last || "")) shifted += 1;
  }
  return shifted;
}

/** Group per-day channel revenue rows (ChannelRevenueDaily) by source/medium into totals + AOV, sorted
 *  by revenue desc. Turns first-touch counts into first-touch REVENUE. Also returns the grand total.
 *
 *  Splits SUBSCRIPTION revenue out per channel. Recurring renewals carry the customer's first-touch
 *  source, so this answers "which channel actually drove our subscription revenue" — the question GA4
 *  structurally cannot answer (a renewal has no browser session, so GA4 reports it as Unassigned). */
export function byChannelRevenue(rows = []) {
  const map = new Map();
  let totalRevenue = 0;
  let totalOrders = 0;
  let totalSubscriptionRevenue = 0;
  let totalSubscriptionOrders = 0;
  for (const r of rows) {
    const key = labelOf(r.source, r.medium);
    const agg = map.get(key) || {
      source: r.source || "(direct)",
      medium: r.medium || "(none)",
      orders: 0,
      revenue: 0,
      subscriptionOrders: 0,
      subscriptionRevenue: 0,
    };
    agg.orders += Number(r.orders) || 0;
    agg.revenue += Number(r.revenue) || 0;
    agg.subscriptionOrders += Number(r.subscriptionOrders) || 0;
    agg.subscriptionRevenue += Number(r.subscriptionRevenue) || 0;
    map.set(key, agg);
    totalOrders += Number(r.orders) || 0;
    totalRevenue += Number(r.revenue) || 0;
    totalSubscriptionOrders += Number(r.subscriptionOrders) || 0;
    totalSubscriptionRevenue += Number(r.subscriptionRevenue) || 0;
  }
  const round = (n) => Math.round(n * 100) / 100;
  const channels = [...map.values()]
    .map((a) => ({
      ...a,
      revenue: round(a.revenue),
      subscriptionRevenue: round(a.subscriptionRevenue),
      // One-off (non-subscription) revenue, so the two always reconcile to the total.
      oneOffRevenue: round(a.revenue - a.subscriptionRevenue),
      aov: a.orders ? round(a.revenue / a.orders) : 0,
      // Share of total attributed revenue — the headline "which channels drive sales" number.
      share: totalRevenue > 0 ? Math.round((a.revenue / totalRevenue) * 100) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);
  return {
    channels,
    totalRevenue: round(totalRevenue),
    totalOrders,
    totalSubscriptionRevenue: round(totalSubscriptionRevenue),
    totalSubscriptionOrders,
  };
}

/**
 * Lifetime value + retention by ACQUIRING channel. Joins per-customer lifetime totals (CustomerLifetime,
 * from the backfill) to their first-touch channel (CustomerAttribution). Customers with lifetime but no
 * attribution row fall into "(unattributed)" — kept honest, not folded into a real channel.
 *
 * Per channel: customers, total + average lifetime revenue (LTV), average orders, repeat rate (>1 order)
 * and active rate (ordered within `activeWithinDays`). Sorted by LTV desc. Pure.
 */
export function ltvByChannel(customers = [], lifetimes = [], { activeWithinDays = 60, asOf = null } = {}) {
  const attrByKey = new Map(customers.map((c) => [c.customerKey, c]));
  const now = asOf ? new Date(asOf) : new Date();
  const activeSince = new Date(now.getTime() - activeWithinDays * 86400000).toISOString().slice(0, 10);
  const map = new Map();
  for (const lt of lifetimes) {
    const c = attrByKey.get(lt.customerKey);
    const source = c?.source || "(unattributed)";
    const medium = c?.medium || "(none)";
    const key = `${source} / ${medium}`;
    const agg = map.get(key) || { source, medium, customers: 0, revenue: 0, orders: 0, repeat: 0, active: 0 };
    agg.customers += 1;
    agg.revenue += Number(lt.revenue) || 0;
    agg.orders += Number(lt.orders) || 0;
    if ((Number(lt.orders) || 0) > 1) agg.repeat += 1;
    if (lt.lastOrderAt && lt.lastOrderAt >= activeSince) agg.active += 1;
    map.set(key, agg);
  }
  const round = (n) => Math.round(n * 100) / 100;
  return [...map.values()]
    .map((a) => ({
      ...a,
      revenue: round(a.revenue),
      ltv: a.customers ? round(a.revenue / a.customers) : 0,
      avgOrders: a.customers ? round(a.orders / a.customers) : 0,
      repeatRate: a.customers ? Math.round((a.repeat / a.customers) * 100) : 0,
      activeRate: a.customers ? Math.round((a.active / a.customers) * 100) : 0,
    }))
    .sort((a, b) => b.ltv - a.ltv);
}

/** Group subscription first-order attribution (CustomerAttribution) by source/medium, sorted desc. */
export function bySubscriptionSource(rows = []) {
  const map = new Map();
  for (const r of rows) {
    const key = labelOf(r.source, r.medium);
    const agg = map.get(key) || { source: r.source || "(direct)", medium: r.medium || "(none)", customers: 0 };
    agg.customers += 1;
    map.set(key, agg);
  }
  return [...map.values()].sort((a, b) => b.customers - a.customers);
}
