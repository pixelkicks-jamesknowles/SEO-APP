# Spec: custom first-party subdomain for a truly ITP-proof durable id

## Why

The durable visitor id (`pxp_id`) is what stitches a visitor across sessions and feeds the identity graph
(cross-device/cross-session first-touch). Today it is set two ways, both compromised:

- The app-proxy `/id` loader returns a `Set-Cookie`, but **Shopify's App Proxy does not reliably pass
  Set-Cookie through to the browser**, so this usually never lands (see `proxy.$type.jsx`, `durable-id.server.js`).
- The theme embed therefore writes `pxp_id` itself as a **JS cookie** (`seo-engagement.js`). That works, but
  a script-set cookie on Safari is capped at **7 days** by ITP. Chrome/Firefox keep it ~400 days.

So on Safari the durable id — and any cross-session attribution built on it — silently resets weekly. This is
the single remaining gap after the 2026-07-14 visitor-tracking fix (which made first-touch populate at all).

## The fix (what Elevar / Stape do)

Serve the app from a **first-party subdomain of the merchant's own store domain**, e.g.
`data.naturaw.co.uk`, via a CNAME to our host. A cookie set by an HTTP response from that subdomain is a
**first-party, server-set cookie**, which ITP does **not** cap at 7 days. The id becomes genuinely durable on
Safari too, and the `/id`, `/visit`, `/track` calls stop depending on the App Proxy for cookie persistence.

## What it needs from the merchant (per store — this is why it can't be pure code)

1. A DNS **CNAME** record: `data.<merchant-domain>` → our ingest host (Railway custom domain / Cloudflare).
2. TLS for that subdomain (Railway/Cloudflare-managed cert, or ACME).
3. The subdomain registered as a Railway custom domain (or fronted by Cloudflare) pointing at the app.

## Code changes required (our side)

1. **Config**: per-shop `firstPartyHost` setting (e.g. `data.naturaw.co.uk`), plus a global fallback. Store on
   `TrackingSettings`.
2. **Cookie domain**: `durable-id.server.js` sets the `pxp_id` cookie with `Domain=.<merchant-domain>` and
   `Secure; SameSite=Lax` from the subdomain response (not the App Proxy). Keep the App-Proxy path as a
   fallback for stores without a subdomain configured.
3. **Embed**: when `firstPartyHost` is set, point `/id`, `/visit`, `/track` at `https://<firstPartyHost>/...`
   instead of the `/apps/pixelify-seo` proxy. Requests are then same-site (subdomain of the storefront), so
   the cookie rides along and CORS is first-party. `seo-engagement.js` already reads/writes `pxp_id`; it would
   read the (now server-set, uncapped) cookie instead of writing its own.
4. **CORS/CSRF**: the subdomain endpoints must accept the storefront origin and validate the shop (HMAC or a
   signed shop param, since these calls no longer carry the App Proxy signature).
5. **Server-set cookie on `/visit` and `/track`**: return `Set-Cookie` from the subdomain so the id is minted
   even for visitors who never trigger `/id`.

## Sequencing / risk

- Ship behind the per-shop `firstPartyHost` setting: unset → current behaviour (App Proxy + JS cookie),
  set → first-party subdomain. Zero regression for stores that don't configure it.
- The App-Proxy HMAC auth is replaced on the subdomain path, so the shop-authentication code must be written
  and tested carefully — it's the one place this widens the attack surface.
- Verify on Safari specifically (the whole point): confirm `pxp_id` survives > 7 days.

## Status

Not built. Blocked on the merchant providing the DNS CNAME + subdomain. The 2026-07-14 visitor-tracking fix
means the top-of-funnel now populates without this; this only upgrades Safari durability from 7 days to
permanent. Medium priority.
