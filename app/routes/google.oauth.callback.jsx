// Google OAuth callback (outside the embedded iframe — opened in a new tab from Settings). Verifies
// the signed state → shop, exchanges the code for tokens, stores them (encrypted), and renders a tiny
// "you can close this tab" page. NOT under /auth (Shopify's auth.$ catch-all owns that path).
import { exchangeAndStore, consumeOAuthState, googleRedirectUri } from "../lib/google-ads.server";

// Escape anything interpolated into the HTML below. `?error=` and the token-exchange error message are
// attacker-influenced, so raw interpolation would be reflected XSS on this (standalone) page.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const page = (title, body) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f6f6f7;color:#202223;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.c{max-width:420px;background:#fff;border:1px solid #e1e3e5;border-radius:12px;padding:32px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#6d7175;line-height:1.5;margin:0}</style></head><body><div class="c"><h1>${title}</h1><p>${body}</p></div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const err = url.searchParams.get("error");
  if (err) return page("Google connection cancelled", `Google returned: ${esc(err)}. You can close this tab and try again.`);

  const code = url.searchParams.get("code");
  const shop = await consumeOAuthState(url.searchParams.get("state"));
  if (!code || !shop) return page("Couldn't connect", "The connection link was invalid or expired. Reopen it from the app's Settings page.");

  try {
    await exchangeAndStore(shop, code, googleRedirectUri());
    return page("Google Ads connected", "Your Google account is connected. You can close this tab and return to the app — set your customer ID and conversion action on the Settings page.");
  } catch (e) {
    return page("Couldn't connect", `Google rejected the token exchange: ${esc(e?.message || "unknown error")}. Check the OAuth client + redirect URI, then try again.`);
  }
};
