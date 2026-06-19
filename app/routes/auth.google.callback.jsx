import { exchangeCode } from "../lib/gsc.server";
import prisma from "../db.server";

// Google OAuth callback: exchange the code for tokens and store them for the shop (from `state`).
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("state");
  if (!code || !shop) {
    return new Response("Missing authorization code or shop.", { status: 400 });
  }

  const tok = await exchangeCode(code);
  if (tok.error || !tok.access_token) {
    return new Response(`Google token exchange failed: ${tok.error || "no token returned"}`, {
      status: 400,
    });
  }

  const expiresAt = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null;
  await prisma.googleToken.upsert({
    where: { shopDomain: shop },
    create: {
      shopDomain: shop,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt,
    },
    update: {
      accessToken: tok.access_token,
      ...(tok.refresh_token ? { refreshToken: tok.refresh_token } : {}),
      expiresAt,
    },
  });

  return new Response(
    "<!doctype html><html><body style='font-family:system-ui;padding:2rem'><h2>Search Console connected ✓</h2><p>You can close this tab and return to the app.</p></body></html>",
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
};
