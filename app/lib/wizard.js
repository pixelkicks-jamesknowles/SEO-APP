// Pure setup-diagnostic checklist (no IO — unit-tested). Turns a shop's TrackingSettings + decrypted
// keys into an ordered list of pass/fail checks with a fix link, powering the self-diagnosing wizard.

function matrixHas(settings, platform, name) {
  try {
    const m = JSON.parse(settings?.eventMatrix || "{}");
    return Array.isArray(m?.[platform]) && m[platform].includes(name);
  } catch {
    return false;
  }
}

/** items: [{ key, label, ok, hint, url }] in setup order. keys = readServerSideKeys(settings). */
export function buildChecklist(settings, keys) {
  const s = settings || {};
  const k = keys || {};
  const has = (v) => Boolean(v);
  const idsSet = has(s.ga4Id) || has(s.gtmId) || has(s.metaPixelId);
  const items = [
    { key: "destination", label: "A destination is configured (GA4, Meta or GTM)", ok: idsSet, hint: "Add a destination ID on the Tracking page.", url: "/app/tracking" },
    { key: "serverSide", label: "Server-side delivery is on", ok: has(s.serverSide), hint: "Turn on Server-side delivery on the Tracking page.", url: "/app/tracking" },
    { key: "pixel", label: "Web Pixel is installed on the storefront", ok: has(s.webPixelId), hint: "Save the Tracking page once to create the Web Pixel.", url: "/app/tracking" },
  ];
  if (has(s.ga4Id)) {
    items.push({ key: "ga4secret", label: "GA4 Measurement Protocol secret is saved", ok: has(k.ga4ApiSecret), hint: "Add the GA4 API secret on the Settings page.", url: "/app/settings" });
    items.push({ key: "ga4purchase", label: "GA4 is set to receive purchases", ok: matrixHas(s, "ga4", "checkout_completed"), hint: "Tick checkout_completed for GA4 in the event matrix.", url: "/app/tracking" });
  }
  if (has(s.metaPixelId)) {
    items.push({ key: "metatoken", label: "Meta CAPI access token is saved", ok: has(k.metaCapiToken), hint: "Add the Meta CAPI token on the Settings page.", url: "/app/settings" });
  }
  if (has(s.gtmId)) {
    items.push({ key: "gtmurl", label: "Server-side GTM container URL is saved", ok: has(k.gtmServerUrl), hint: "Add the sGTM container URL on the Settings page.", url: "/app/settings" });
  }
  return items;
}

/** "ready" (all pass), "partial" (some), or "empty" (none). */
export function checklistStatus(items = []) {
  if (items.length && items.every((i) => i.ok)) return "ready";
  if (items.some((i) => i.ok)) return "partial";
  return "empty";
}

/**
 * State for the hand-holding setup wizard (the plain-language, 3-step flow for non-technical merchants).
 * Only GA4 is required — the wizard turns on server-side, sets the event matrix and creates the pixel for
 * them behind the scenes, so the merchant only ever pastes two values.
 *   step 1 — Connect GA4 (measurement ID)
 *   step 2 — Add the GA4 secret
 *   step 3 — Turn on the theme embed + run a live test (embed can't be detected, so it's the final screen)
 * `started` gates the on-install redirect (fresh install → wizard); `complete` gates the Home nudge. Pure.
 */
export function wizardState(settings, keys) {
  const s = settings || {};
  const k = keys || {};
  const hasGa4 = Boolean(s.ga4Id);
  const hasSecret = Boolean(k.ga4ApiSecret);
  const started = hasGa4 || Boolean(s.serverSide);
  const complete = hasGa4 && hasSecret && Boolean(s.serverSide) && Boolean(s.webPixelId);
  let step = 1;
  if (hasGa4 && !hasSecret) step = 2;
  else if (hasGa4 && hasSecret) step = 3;
  return { step, total: 3, started, complete, hasGa4, hasSecret };
}
