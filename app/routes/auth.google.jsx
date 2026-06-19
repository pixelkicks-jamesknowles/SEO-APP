import { redirect } from "@remix-run/node";

// Top-level entry to Google's OAuth consent (reached via a target=_top link from /app/gsc).
// The shop is carried in `state` so the callback knows which store to store the token for.
export const loader = async ({ request }) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return new Response("GOOGLE_CLIENT_ID is not configured. See DEPLOY.md.", { status: 501 });
  }
  const shop = new URL(request.url).searchParams.get("shop") || "";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${process.env.SHOPIFY_APP_URL}/auth/google/callback`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    access_type: "offline",
    prompt: "consent",
    state: shop,
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
};
