// Analytics-consent classification for reporting (pure — unit-tested).
//
// NOTE: there used to be an `analyticsConsented()` helper here that folded UNKNOWN consent into GRANTED.
// That is the correct convention for DELIVERY (send the event, consent-flagged, and let GA4 model the
// gap) but it was also being used for the Accuracy consent counters, where it silently reported "we never
// received a consent signal" as "the shopper accepted". It has been removed rather than left as a
// footgun; the delivery paths gate on settings.consentMode / consentSignals directly.
/**
 * THREE-STATE consent classification, for REPORTING only.
 *
 * Deliberately different from analyticsConsented() above, which encodes the DELIVERY convention (unknown
 * → treat as granted, so events still send). Applying that convention to a consent-rate METRIC is
 * misleading: it silently counts "we never received a consent signal" as "the shopper accepted". A store
 * running with Consent mode off sends no consent object at all, so every event scores as granted and the
 * dashboard reads a flawless 100% with zero denials — which measures nothing.
 *
 * "granted" and "denied" require an explicit signal; everything else is "unknown" and is reported as
 * such rather than folded into either. Pure.
 */
export function consentState(consent) {
  if (consent && consent.analytics === true) return "granted";
  if (consent && consent.analytics === false) return "denied";
  return "unknown";
}

/**
 * Analytics consent as captured on the ORDER by the theme app embed (a `pxp_analytics_consent` note
 * attribute). Returns "granted" | "denied" | "unknown".
 *
 * This is the only complete source of order-level consent. The webhook payload carries no consent of its
 * own — `buyer_accepts_marketing` is MARKETING consent and answering an analytics question with it would
 * be wrong — and the Web Pixel only reports consent when it manages to observe the checkout, which is
 * precisely the case that fails most often. The embed runs on every storefront page and reads Shopify's
 * Customer Privacy API directly, so it knows the real answer. "unknown" means the embed never ran (not
 * installed, or the shopper never hit a themed page). Pure.
 */
export function orderConsentState(order) {
  const raw = (order?.note_attributes || []).find((a) => a?.name === "pxp_analytics_consent")?.value;
  const v = String(raw || "").toLowerCase();
  if (v === "granted") return "granted";
  if (v === "denied") return "denied";
  return "unknown";
}
