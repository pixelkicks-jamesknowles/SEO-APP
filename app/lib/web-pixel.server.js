// Shared Web Pixel sync — creates or updates the Web Pixel sandbox config. Used by the Tracking save AND
// the setup wizard, so both install the pixel the same way (a merchant who only finishes the wizard still
// gets a working pixel). The Web Pixel's strict sandbox blocks same-origin requests, so it beacons
// cross-origin to the app host — that absolute URL + a shop-scoped token are baked into the config here.
import { pixelToken } from "./pixel-token.server";

const CREATE_PIXEL = `#graphql
  mutation CreateWebPixel($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel { id }
      userErrors { field message }
    }
  }`;

const UPDATE_PIXEL = `#graphql
  mutation UpdateWebPixel($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      webPixel { id }
      userErrors { field message }
    }
  }`;

/**
 * Create/update the Web Pixel. Returns { webPixelId, pixelError }. `existingId` is the stored id (null to
 * force create); a stale id (pixel deleted/reset) self-heals by dropping it and creating a fresh one.
 * `config` = { gtmId, ga4Id, metaPixelId, eventMatrix (object), consentMode, consentSignals, debug }.
 */
export async function syncWebPixel({ admin, appHost, shopDomain, existingId = null, config = {} }) {
  const pixelSettings = {
    config: JSON.stringify({
      gtmId: config.gtmId || "",
      ga4Id: config.ga4Id || "",
      metaPixelId: config.metaPixelId || "",
      eventMatrix: config.eventMatrix || {},
      consentMode: config.consentMode,
      consentSignals: config.consentSignals,
      debug: config.debug,
      trackUrl: `${appHost.replace(/\/$/, "")}/pixel/track`,
      shopDomain,
      trackToken: pixelToken(shopDomain),
    }),
  };
  const input = { settings: JSON.stringify(pixelSettings) };

  let webPixelId = existingId || null;
  let pixelError = null;
  const createPixel = async () => {
    const res = await admin.graphql(CREATE_PIXEL, { variables: { webPixel: input } });
    const json = await res.json();
    const errs = json.data?.webPixelCreate?.userErrors ?? [];
    if (errs.length) pixelError = errs.map((e) => e.message).join("; ");
    else webPixelId = json.data?.webPixelCreate?.webPixel?.id ?? null;
  };
  try {
    if (webPixelId) {
      const res = await admin.graphql(UPDATE_PIXEL, { variables: { id: webPixelId, webPixel: input } });
      const json = await res.json();
      const errs = json.data?.webPixelUpdate?.userErrors ?? [];
      // The stored pixel can vanish (app reinstall, dev-store reset, manual delete). When the update can't
      // find it, drop the stale id and create a fresh pixel so the save self-heals.
      if (errs.some((e) => /couldn't be found|could not be found|does not exist/i.test(e.message))) {
        webPixelId = null;
        await createPixel();
      } else if (errs.length) {
        pixelError = errs.map((e) => e.message).join("; ");
      }
    } else {
      await createPixel();
    }
  } catch (e) {
    pixelError = e.message;
  }
  return { webPixelId, pixelError };
}
