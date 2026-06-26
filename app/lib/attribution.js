// Pure first-touch attribution helpers for subscription tracking (seo-subscription-tracking-v1 M2).
// The first order we see for a customer establishes the GA4 client_id + source/medium/campaign;
// every later (recurring) order inherits it so it isn't mis-attributed to direct traffic. No IO here.

const UTM = { source: "utm_source", medium: "utm_medium", campaign: "utm_campaign" };

/** Pull UTM source/medium/campaign from an order's landing_site URL, falling back to note_attributes. */
export function parseUtms(order) {
  const out = { source: null, medium: null, campaign: null };
  if (order?.landing_site) {
    try {
      const sp = new URL(order.landing_site, "https://placeholder.invalid").searchParams;
      for (const [k, param] of Object.entries(UTM)) {
        const v = sp.get(param);
        if (v) out[k] = v;
      }
    } catch {
      /* malformed landing_site — fall through to note_attributes */
    }
  }
  const na = order?.note_attributes || [];
  const note = (n) => na.find((a) => a?.name === n)?.value || null;
  for (const [k, param] of Object.entries(UTM)) {
    if (!out[k]) out[k] = note(param);
  }
  return out;
}

/** Stable per-customer key: the customer id when present, else a normalized email, else null. */
export function customerKey(order) {
  if (order?.customer?.id) return String(order.customer.id);
  const email = order?.email || order?.customer?.email;
  return email ? `e:${String(email).trim().toLowerCase()}` : null;
}
