// Install-time double-counting detection. The #1 way a merchant's data goes wrong isn't a missed event —
// it's the SAME purchase counted twice because another tag is already on the storefront (a hard-coded
// gtag, Shopify's native Google & YouTube / Meta channels, GTM, another tracking app). We fetch the
// storefront HTML and look for the tell-tale snippets so we can warn + point at the dedup guidance
// (GA4 collapses on transaction_id, Meta on event_id — both of which this app already sets).
//
// Best-effort and detection-only: a password-protected or JS-rendered store may hide tags, so absence is
// not proof of a clean setup. Pure matching (detectTrackersInHtml) is unit-tested; the fetch is here.

// name → signals to look for in the raw HTML. Ordered roughly by how commonly they double-count.
const SIGNATURES = [
  { key: "ga4", label: "Google Analytics 4 (gtag)", re: /gtag\/js\?id=G-|googletagmanager\.com\/gtag\/js|\bG-[A-Z0-9]{6,}\b/ },
  { key: "gtm", label: "Google Tag Manager container", re: /googletagmanager\.com\/gtm\.js|\bGTM-[A-Z0-9]{4,}\b/ },
  { key: "meta", label: "Meta Pixel (fbq)", re: /connect\.facebook\.net\/[^"']*\/fbevents\.js|\bfbq\(\s*['"]init['"]/ },
  { key: "tiktok", label: "TikTok Pixel", re: /analytics\.tiktok\.com\/i18n\/pixel|ttq\.load\(/ },
  { key: "pinterest", label: "Pinterest Tag", re: /s\.pinimg\.com\/ct\/core\.js|pintrk\(/ },
  { key: "snap", label: "Snap Pixel", re: /sc-static\.net\/scevent\.min\.js|snaptr\(/ },
  { key: "bing", label: "Microsoft/Bing UET", re: /bat\.bing\.com\/bat\.js|\buetq\b/ },
];

/** Detect known tracker signatures in raw storefront HTML. Pure — returns [{ key, label }]. */
export function detectTrackersInHtml(html) {
  if (typeof html !== "string" || !html) return [];
  return SIGNATURES.filter((s) => s.re.test(html)).map(({ key, label }) => ({ key, label }));
}

/**
 * Fetch a shop's storefront homepage and detect existing trackers. Returns
 * { ok, url, detected: [{key,label}], note? }. Never throws. A short timeout keeps a slow/blocked store
 * from hanging the settings page.
 */
export async function scanStorefront(shopDomain, { timeoutMs = 6000 } = {}) {
  if (!shopDomain) return { ok: false, detected: [], note: "No shop domain." };
  const url = `https://${shopDomain}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PixelKicksScan/1.0)", Accept: "text/html" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, url, detected: [], note: `Storefront returned HTTP ${res.status} (password-protected stores can't be scanned).` };
    const html = (await res.text()).slice(0, 800_000); // cap: only the head/body top carries tag snippets
    const detected = detectTrackersInHtml(html);
    return { ok: true, url, detected };
  } catch (e) {
    const note = e?.name === "AbortError" ? "The storefront took too long to respond." : e?.message || "Couldn't reach the storefront.";
    return { ok: false, url, detected: [], note };
  } finally {
    clearTimeout(timer);
  }
}
