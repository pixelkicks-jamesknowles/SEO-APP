import prisma from "../db.server";

// Google Search Console integration. UNTESTED from here — needs GOOGLE_CLIENT_ID/SECRET, a
// deployed host, and a GSC property matching the store domain. Structured for completion on deploy.

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${process.env.SHOPIFY_APP_URL}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  return res.json();
}

// A valid access token for the shop, refreshing if it's expired. null if not connected.
export async function getAccessToken(shopDomain) {
  const tok = await prisma.googleToken.findUnique({ where: { shopDomain } });
  if (!tok) return null;
  if (tok.expiresAt && tok.expiresAt.getTime() > Date.now() + 60_000) return tok.accessToken;
  if (!tok.refreshToken) return tok.accessToken;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tok.refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (json.error || !json.access_token) return tok.accessToken;
  await prisma.googleToken.update({
    where: { shopDomain },
    data: {
      accessToken: json.access_token,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    },
  });
  return json.access_token;
}

// Top queries for the last 28 days from Search Console.
export async function querySearchAnalytics(accessToken, siteUrl) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const end = new Date();
  const start = new Date(Date.now() - 28 * 86400 * 1000);
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: fmt(start),
        endDate: fmt(end),
        dimensions: ["query"],
        rowLimit: 10,
      }),
    },
  );
  const json = await res.json();
  if (json.error) return { error: json.error.message || "Search Console query failed." };
  return {
    rows: (json.rows || []).map((r) => ({
      query: r.keys?.[0] ?? "",
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
    })),
  };
}
