// Ad-network click identifiers → the source/medium they imply. Pure, no IO.
//
// Why this exists: Google Ads and Microsoft Ads use AUTO-TAGGING, which puts a click id on the landing
// URL (`gclid`, `msclkid`) and no UTM parameters at all. Attribution that only reads `utm_*` therefore
// sees nothing on a paid click and files the order as direct — which is why a store can show heavy paid
// traffic and almost no paid revenue. Reading the click id recovers the channel without the merchant
// having to hand-tag every ad.

// Ordered: the unambiguously-paid ids are checked FIRST, so a URL carrying both a gclid and an fbclid
// (a Google ad landing on a page later shared to Facebook, say) resolves to the paid click.
//
// `medium: "cpc"` is only used where the id can ONLY be produced by a paid placement. fbclid is the
// deliberate exception: Facebook and Instagram append it to EVERY outbound link click, organic posts
// included, so marking it paid would silently reclassify organic social traffic as advertising. It maps
// to organic social, which still beats the "(direct)" it lands in today.
const CLICK_IDS = [
  { param: "gclid", source: "google", medium: "cpc" }, // Google Ads
  { param: "gbraid", source: "google", medium: "cpc" }, // Google Ads, iOS web-to-app
  { param: "wbraid", source: "google", medium: "cpc" }, // Google Ads, iOS app-to-web
  { param: "msclkid", source: "bing", medium: "cpc" }, // Microsoft Advertising
  { param: "ttclid", source: "tiktok", medium: "cpc" }, // TikTok Ads
  { param: "sccid", source: "snapchat", medium: "cpc" }, // Snapchat Ads (ScCid on the wire)
  { param: "fbclid", source: "facebook", medium: "social" }, // ambiguous — see above
];

/**
 * Resolve a landing URL to { source, medium, campaign: null } from its click id, or null when it carries
 * none. Accepts a full URL or a path+query (Shopify's `landing_site` is the latter). Campaign is never
 * inferred — a click id says which network sent the click, not which campaign. Pure.
 */
export function clickIdChannel(url) {
  if (!url || typeof url !== "string") return null;
  let params;
  try {
    params = new URL(url, "https://placeholder.invalid").searchParams;
  } catch {
    return null;
  }
  // Query parameters are case-sensitive but networks are inconsistent about casing (Snapchat ships
  // `ScCid`), so match on a lower-cased copy of the keys rather than exact names.
  const seen = new Map();
  for (const [k, v] of params) {
    if (v) seen.set(k.toLowerCase(), v);
  }
  if (!seen.size) return null;
  for (const { param, source, medium } of CLICK_IDS) {
    if (seen.has(param)) return { source, medium, campaign: null };
  }
  return null;
}

/** The click-id parameter names, for callers that only need to know whether one is present. */
export const CLICK_ID_PARAMS = CLICK_IDS.map((c) => c.param);
