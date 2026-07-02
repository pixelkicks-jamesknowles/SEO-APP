// Pure multi-currency normalization (no IO — unit-tested). Converts a built GA4 params object or a
// Meta custom_data object from its own currency into the shop's reporting currency, so ad platforms
// optimise on comparable numbers across markets. The original amount/currency are preserved as
// `original_value` / `original_currency` params. Rates are USD-based (see fx.server.js).

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Cross rate to convert 1 unit of `from` into `to`, given USD-based rates (units per 1 USD).
 *  Returns 1 when from===to, and null when either currency is unknown (caller then skips conversion). */
export function crossRate(rates, from, to) {
  if (!from || !to || from === to) return 1;
  const rf = Number(rates?.[from]);
  const rt = Number(rates?.[to]);
  if (!rf || !rt) return null;
  return rt / rf;
}

/** Convert an event object's monetary fields in place into `to` currency. Handles GA4 (`value`,
 *  `revenue`, `items[].price`) and Meta (`value`, `contents[].item_price`) shapes. No-op when the
 *  object has no currency, already matches `to`, or the currency pair is unknown. Returns the object. */
export function normalizeParams(obj, { rates, to } = {}) {
  if (!obj || typeof obj !== "object" || !to) return obj;
  const from = obj.currency;
  if (!from || from === to) return obj;
  const rate = crossRate(rates, from, to);
  if (!rate) return obj; // unknown currency pair — leave the raw amounts untouched
  const conv = (v) => round2(Number(v) * rate);

  if (typeof obj.value === "number") {
    obj.original_value = obj.value;
    obj.value = conv(obj.value);
  }
  if (typeof obj.revenue === "number") obj.revenue = conv(obj.revenue);
  if (Array.isArray(obj.items)) {
    for (const it of obj.items) if (typeof it?.price === "number") it.price = conv(it.price);
  }
  if (Array.isArray(obj.contents)) {
    for (const c of obj.contents) if (typeof c?.item_price === "number") c.item_price = conv(c.item_price);
  }
  obj.original_currency = from;
  obj.currency = to;
  return obj;
}
