# Pixelify SEO — App Store listing draft

Go-to-market copy + asset checklist for the Shopify App Store submission. Pair with the build in
this repo and the deploy steps in [DEPLOY.md](./DEPLOY.md).

## Name & tagline
- **Name:** Pixelify SEO & Tracking
- **Tagline (≤62 chars):** Deterministic SEO + consent-safe tracking. No AI guesswork.

## Short description (≤120 chars)
Schema, meta templates, redirects, Core Web Vitals, and GTM/GA4/Meta/TikTok tracking — accurate, no AI hallucinations.

## Long description
Pixelify SEO is the **deterministic** SEO + analytics app. While other apps fill your store with
AI-generated meta (and the hallucinated specs that come with it), Pixelify uses templates, rules,
and **validated** structured data you can trust.

**SEO**
- Variable-based meta templates (title + description) applied across products and collections — predictable, reproducible, no AI.
- Validated JSON-LD (Product, Breadcrumb, Organization, FAQ, Article, LocalBusiness) via a theme-app-extension embed, with a **dedup pass** so you never get duplicate schema.
- **Rich-results validation**: fetch any URL and check its structured data against Google's requirements.
- **Technical audit + score** (missing/over-length titles & descriptions, missing alt text) with sample offenders.
- **Redirects**: manual + bulk CSV import + auto-301 on product handle changes + a 404 manager.
- robots.txt, HTML sitemap, IndexNow, and a deterministic `llms.txt` export for AI answer engines.
- **Core Web Vitals** field data via the Chrome UX Report API.
- **Google Search Console** — impressions, clicks, top queries.

**Tracking**
- GTM, GA4, Meta, TikTok, Pinterest, Snap, Bing — paste an ID, tick which events to send.
- Fired via the **Web Pixels API**, so checkout & purchase are covered.
- **Consent-gated** (Customer Privacy API) + optional **server-side** delivery (GA4 MP / Meta CAPI).
- Live event debugger.

**Works on any theme.** Scheduled monitoring alerts you when your SEO score drops.

## Pricing
| Plan | Price | Highlights |
| --- | --- | --- |
| Free | $0 | Schema + dedup + basic audit, 1 tracking platform |
| Starter | $15/mo | Meta templates, all client-side tags + events, redirects, GSC |
| Growth | $39/mo | Full audit + CWV, llms.txt, consent mode |
| Pro | $79/mo | Server-side tracking, programmatic pages, agency multi-store |

## Screenshots to capture (1600×900)
1. SEO audit + score with issues
2. Meta templates with the variable chips + Apply
3. Tracking event matrix
4. Redirects (auto-301 + CSV import)
5. Web Vitals (CrUX)
6. Live events / monitoring alert

## Keywords
seo, json-ld, structured data, rich results, meta tags, redirects, 404, core web vitals,
google search console, gtm, ga4, meta pixel, tiktok pixel, conversion tracking, consent mode

## Pre-submission checklist
- [ ] Deploy to a public host + set env (see DEPLOY.md), App Store distribution selected.
- [ ] App-managed pricing configured (Plans page billing).
- [ ] GDPR webhooks + app proxy restored in `shopify.app.toml`.
- [ ] Listing screenshots + 5-min demo video.
- [ ] Tested on a non-Pixelify theme (the "works on any theme" claim).
- [ ] Privacy policy + support email/URL.
