// Pure aggregation for the in-app Attribution report (no IO — unit-tested). Turns the raw
// VisitorAttribution / CustomerAttribution rows (already captured by the tracking pipeline) into the
// summaries the report renders: top first-touch sources, touch-count distribution, first-vs-last-touch
// shift, and subscription first-order sources.

const labelOf = (source, medium) => `${source || "(direct)"} / ${medium || "(none)"}`;

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
