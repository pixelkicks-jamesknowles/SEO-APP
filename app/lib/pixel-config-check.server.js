// Scheduled Web Pixel CONFIG verification.
//
// The pixel's `trackUrl` and shop-scoped `trackToken` are baked into its sandbox settings at save time
// (web-pixel.server.js) and never re-validated. Two things silently invalidate them:
//
//   • the app host changes (a new Railway domain, a custom domain) — the pixel keeps beaconing at the
//     old URL, which simply stops answering;
//   • SHOPIFY_API_SECRET is rotated — the baked token no longer matches what the server derives, and
//     /pixel/track answers a bad token with a deliberate SILENT 204 (so the endpoint can't be used to
//     probe which shops are installed).
//
// Either way every storefront beacon is dropped with no error, no log and no counter. A shop can be dark
// for months and the only outward sign is that server-side recovery quietly does all the work — which is
// exactly how this went unnoticed until a client asked why their paid channels looked empty.
//
// So: read the live pixel's settings back from the Admin API on a cadence and compare them to what the
// server expects. A mismatch is stored like any other connection check, which means computeHealth turns
// it into an in-app banner AND pushes it to the merchant's alert webhook through the existing path.
import prisma from "../db.server";
import { pixelToken } from "./pixel-token.server";

// Re-verify at most this often per shop. Config drift is rare and an Admin API call is not free, so this
// is deliberately slower than the cron interval; the check is a safety net, not a monitor.
export const PIXEL_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const PIXEL_DESTINATION = "web_pixel";

const READ_PIXEL = `#graphql
  query ConnectAnalyticsWebPixel($id: ID!) {
    webPixel(id: $id) { id settings }
  }`;

/**
 * Compare a Web Pixel's stored settings against what this deployment expects. Pure, so the comparison
 * (the part with the actual logic) is testable without an Admin client.
 *
 * `settings` is the raw JSON string Shopify returns. Our shape is { config: "<json string>" } — the config
 * is double-encoded, because WebPixelInput.settings is itself a JSON string.
 *
 * Returns { ok, detail } where detail names the specific drift, so the alert tells a merchant what to do
 * rather than just that something is wrong.
 */
export function checkPixelSettings(rawSettings, { expectedUrl, expectedToken } = {}) {
  let config;
  try {
    const outer = typeof rawSettings === "string" ? JSON.parse(rawSettings) : rawSettings;
    config = typeof outer?.config === "string" ? JSON.parse(outer.config) : outer?.config;
  } catch {
    return { ok: false, detail: "The Web Pixel's settings could not be read. Re-save the Tracking page to rewrite them." };
  }
  if (!config) return { ok: false, detail: "The Web Pixel has no configuration. Re-save the Tracking page to rewrite it." };

  const problems = [];
  if (expectedUrl && config.trackUrl !== expectedUrl) {
    problems.push(`it is sending events to ${config.trackUrl || "(nothing)"} instead of ${expectedUrl}`);
  }
  if (expectedToken && config.trackToken !== expectedToken) {
    // Never log either token — this string reaches the in-app banner and the merchant's alert webhook.
    problems.push("its access token no longer matches this app (the app secret was rotated after the pixel was saved)");
  }
  if (!problems.length) return { ok: true, detail: null };
  return {
    ok: false,
    detail: `The Web Pixel is installed but ${problems.join(", and ")}. Every storefront event it sends is being discarded. Open the Tracking page and press Save to repair it.`,
  };
}

/**
 * Cron pass: verify each installed shop's Web Pixel config. Best-effort → summary for the tick log.
 * `adminFor` is injected so this is testable without the Shopify SDK (and so the module can be imported
 * by unit tests without initialising it).
 */
export async function runPixelConfigChecks({ now = Date.now(), limit = 200, adminFor } = {}) {
  const appHost = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  // With no configured host we cannot know what the pixel SHOULD point at, and guessing would produce a
  // false alarm on every shop. Skip rather than mislead.
  if (!appHost) return { checked: 0, failing: 0, skipped: "no SHOPIFY_APP_URL" };

  const shops = await prisma.trackingSettings
    .findMany({ where: { webPixelId: { not: null } }, take: limit })
    .catch(() => []);

  let checked = 0;
  let failing = 0;
  for (const settings of shops) {
    const { shopDomain, webPixelId } = settings;
    const existing = await prisma.connectionCheck
      .findUnique({ where: { shopDomain_destination: { shopDomain, destination: PIXEL_DESTINATION } } })
      .catch(() => null);
    if (existing && now - new Date(existing.checkedAt).getTime() < PIXEL_CHECK_INTERVAL_MS) continue;

    let result;
    try {
      const resolve = adminFor || (async (shop) => (await import("../shopify.server")).unauthenticated.admin(shop).then((r) => r.admin));
      const admin = await resolve(shopDomain);
      const res = await admin.graphql(READ_PIXEL, { variables: { id: webPixelId } });
      const body = await res.json().catch(() => ({}));
      const pixel = body?.data?.webPixel;
      result = pixel
        ? checkPixelSettings(pixel.settings, { expectedUrl: `${appHost}/pixel/track`, expectedToken: pixelToken(shopDomain) })
        : // The stored id points at a pixel that no longer exists (deleted, or the app was reinstalled).
          // The storefront has no pixel at all, which is worth saying plainly.
          { ok: false, detail: "The Web Pixel is missing from this store, so no storefront events are being captured. Open the Tracking page and press Save to reinstall it." };
    } catch (e) {
      // An Admin API failure says nothing about the pixel, so don't record a false alarm — just skip and
      // retry on the next cadence.
      console.warn("[pixel-config-check]", shopDomain, e?.message || e);
      continue;
    }

    await prisma.connectionCheck
      .upsert({
        where: { shopDomain_destination: { shopDomain, destination: PIXEL_DESTINATION } },
        create: { shopDomain, destination: PIXEL_DESTINATION, ok: result.ok, detail: result.detail },
        update: { ok: result.ok, detail: result.detail, checkedAt: new Date(now) },
      })
      .catch(() => {});
    checked += 1;
    if (!result.ok) failing += 1;
  }
  return { checked, failing };
}
