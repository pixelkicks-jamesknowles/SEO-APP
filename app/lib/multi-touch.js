// Pure multi-touch attribution model engine (no IO — unit-tested). GA4 offers only data-driven / last-click
// in the free tier; this gives the standard rule-based models over a visitor's actual touch path. A "path"
// is the ordered list (oldest→newest) of a converting visitor's attributable touches, snapshotted at
// conversion time (ConversionPath). Each model distributes ONE conversion's value across its touches; the
// report sums the distributed credit per channel.

export const MODELS = ["last_touch", "first_touch", "linear", "position_based", "time_decay"];

export const MODEL_LABELS = {
  last_touch: "Last touch",
  first_touch: "First touch",
  linear: "Linear (equal)",
  position_based: "Position-based (40/20/40)",
  time_decay: "Time decay",
};

const dayMs = 86_400_000;

/**
 * Credit weights for one path under a model — an array aligned to `touches` (oldest→newest) that sums to 1
 * (empty path → []). `conversionTs` and `halfLifeDays` only matter for time_decay. Pure.
 */
export function creditWeights(touches = [], model = "last_touch", { conversionTs = null, halfLifeDays = 7 } = {}) {
  const n = touches.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  switch (model) {
    case "first_touch":
      return touches.map((_, i) => (i === 0 ? 1 : 0));
    case "last_touch":
      return touches.map((_, i) => (i === n - 1 ? 1 : 0));
    case "linear":
      return touches.map(() => 1 / n);
    case "position_based": {
      // 40% first, 40% last, remaining 20% split across the middle. With no middle (n===2) the 20% is
      // absorbed into the two endpoints (50/50) so it always sums to 1.
      if (n === 2) return [0.5, 0.5];
      const mid = 0.2 / (n - 2);
      return touches.map((_, i) => (i === 0 || i === n - 1 ? 0.4 : mid));
    }
    case "time_decay": {
      // Exponential decay on recency: a touch's weight halves every `halfLifeDays` before the conversion.
      const end = conversionTs != null ? new Date(conversionTs).getTime() : new Date(touches[n - 1].ts).getTime();
      const raw = touches.map((t) => {
        const ageDays = Math.max(0, (end - new Date(t.ts).getTime()) / dayMs);
        return Math.pow(2, -ageDays / halfLifeDays);
      });
      const total = raw.reduce((a, b) => a + b, 0);
      return total > 0 ? raw.map((w) => w / total) : touches.map(() => 1 / n);
    }
    default:
      return touches.map((_, i) => (i === n - 1 ? 1 : 0)); // unknown model → last touch
  }
}

const label = (t) => `${t.source || "(direct)"} / ${t.medium || "(none)"}`;

/**
 * Aggregate credited revenue by channel across conversion paths under a model.
 * paths: [{ value, touches: [{ source, medium, ts }] (oldest→newest), conversionTs? }]
 * Returns rows sorted by credit desc: { source, medium, credit, conversions } where `conversions` is the
 * fractional conversion count credited (so it sums to the number of paths). Pure.
 */
export function creditByModel(paths = [], model = "last_touch", opts = {}) {
  const map = new Map();
  let total = 0;
  for (const p of paths) {
    const touches = p.touches || [];
    const weights = creditWeights(touches, model, { conversionTs: p.conversionTs, ...opts });
    const value = Number(p.value) || 0;
    total += value;
    touches.forEach((t, i) => {
      const w = weights[i] || 0;
      if (!w) return;
      const key = label(t);
      const agg = map.get(key) || { source: t.source || "(direct)", medium: t.medium || "(none)", credit: 0, conversions: 0 };
      agg.credit += value * w;
      agg.conversions += w;
      map.set(key, agg);
    });
  }
  const round = (n) => Math.round(n * 100) / 100;
  return {
    total: round(total),
    rows: [...map.values()]
      .map((a) => ({ ...a, credit: round(a.credit), conversions: round(a.conversions), share: total > 0 ? Math.round((a.credit / total) * 100) : 0 }))
      .sort((a, b) => b.credit - a.credit),
  };
}
