# pixelify-seo

Standalone Shopify app — **SEO + Tracking**, for any Shopify store (Pixelify theme or not).
No AI / no LLM content generation: deterministic templates, rules, and validated structured data.
See the build spec: [`docs/specs/pixelify-platform-spec-v1.md` §11](../../docs/specs/pixelify-platform-spec-v1.md).

Two modules in one app (they share no data — a packaging choice, not cross-app coupling):

- **SEO core** — native `seo.title`/`seo.description` management via deterministic templates, a JSON-LD
  schema engine with **dedup + Rich-Results validation**, technical audit + CWV, redirects/404, robots.
- **Tracking** — GTM / GA4 / Meta / TikTok tags with an **event-selection matrix**, **consent-gated**
  via the Customer Privacy API, firing through the **Web Pixels API** (so events reach checkout).

## Structure

```
app/pixelify-seo/
  shopify.app.toml          app config + scopes + app proxy + privacy webhooks
  prisma/schema.prisma      Session, Shop, SeoSettings, TrackingSettings, Redirect404Log
  app/                      Remix admin (Polaris) — dashboard, SEO, Tracking
  extensions/
    seo-schema/             theme-app-extension APP EMBED → server-rendered JSON-LD in <head>
    tracking-pixel/         WEB PIXEL extension → consented events → GTM/GA4/Meta/TikTok
```

## ⚠️ Before this can run / deploy (Partner side — not in this repo)

This is a **scaffold**. To make it a live app you must, on the Shopify Partner dashboard:

1. Create the app → get `client_id` / API secret; set them + `SHOPIFY_APP_URL`, `DATABASE_URL`, `SCOPES` in env.
2. Replace `https://example.com` in `shopify.app.toml` (application_url, auth.redirect_urls, app_proxy.url).
3. `pnpm install`, `prisma migrate deploy`, `shopify app dev` (or deploy) to register the extensions.

## ⚠️ Migration order (do NOT skip)

The theme still serves SEO schema + tracking today. **Build → install → dual-run → verify → only then
remove from the theme.** Removing theme code before this app is verified live = a live SEO + analytics
outage. The cutover runbook is tracked separately; nothing in the theme changes until it's signed off.

What the theme KEEPS (not this app's to remove): Horizon `snippets/meta-tags.liquid` (canonical/og/title),
and the Reviews-owned `pixelify-review-schema` / `pixelify-qa-schema` (they move with the Reviews app).
