// Pure first-touch attribution helpers for subscription tracking (seo-subscription-tracking-v1 M2).
// The first order we see for a customer establishes the GA4 client_id + source/medium/campaign;
// every later (recurring) order inherits it so it isn't mis-attributed to direct traffic.
import { sha256Hex } from "./server-side.server";
import { clickIdChannel } from "./click-ids";
import { referrerChannel } from "./attribution-report";

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
      /* malformed landing_site - fall through to note_attributes */
    }
  }
  const na = order?.note_attributes || [];
  const note = (n) => na.find((a) => a?.name === n)?.value || null;
  for (const [k, param] of Object.entries(UTM)) {
    if (!out[k]) out[k] = note(param);
  }
  // Auto-tagged paid clicks carry NO utm_* at all — Google Ads sends `gclid`, Microsoft `msclkid`, and so
  // on. Without this fallback those orders arrive with no source and are recorded as "(direct)", which is
  // why a store can show heavy paid traffic against almost no paid revenue. Only consulted when the UTMs
  // gave us nothing, so a hand-tagged campaign always wins (it is more specific — it knows the campaign).
  if (!out.source && !out.medium) {
    const click = clickIdChannel(order?.landing_site);
    if (click) {
      out.source = click.source;
      out.medium = click.medium;
    }
  }
  return out;
}

/**
 * The acquisition channel an ORDER can see for itself, in descending order of confidence:
 *   1. UTM parameters (landing_site, then note attributes) — the merchant's own tagging.
 *   2. An ad-network click id on the landing URL — recovers auto-tagged paid clicks.
 *   3. The referring site — classified exactly as a storefront visit would be (search → organic,
 *      known network → social, else referral).
 *   4. null — nothing to go on.
 *
 * Step 3 matters as much as step 2: an order from an organic Google search has no UTMs and no click id,
 * so before this it was indistinguishable from someone typing the URL in, and organic search revenue was
 * being reported as direct. Returns { source, medium, campaign } | null. Pure.
 */
export function orderChannel(order) {
  const utms = parseUtms(order);
  if (utms.source || utms.medium || utms.campaign) return utms;
  return referrerChannel(order?.referring_site) || null;
}

/**
 * Did we see ANY journey for this order?
 *
 * The distinction the report depends on: an order with a landing site whose journey carried no marketing
 * signal really was direct (typed the URL, a bookmark). An order with no landing site at all — an API or
 * imported order, or a subscription renewal, which never involved a browser visit — is not direct, it is
 * UNKNOWABLE, and folding it into Direct silently inflates the best-looking channel. Pure.
 */
export function orderHasJourney(order) {
  return Boolean(order?.landing_site || order?.referring_site);
}

/** Stable per-customer key: the customer id when present, else a HASHED email, else null.
 *  The email is sha256-hashed so no raw PII is persisted (same email still maps to the same key). */
export function customerKey(order) {
  if (order?.customer?.id) return String(order.customer.id);
  const email = order?.email || order?.customer?.email;
  return email ? `e:${sha256Hex(email)}` : null;
}
