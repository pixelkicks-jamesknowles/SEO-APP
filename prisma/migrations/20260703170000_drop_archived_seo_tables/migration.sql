-- Drop the archived SEO feature tables. The SEO half of this app was stripped back to a tracking-only
-- product (see README / archive/seo-full-featured); these tables were an unused schema shell — no app
-- code read or wrote them. Safe to drop. Hand-authored (the local Docker DB is offline in dev; Railway
-- applies migrations on deploy), matching the additive migrations already in this directory.
DROP TABLE IF EXISTS "SeoSettings";
DROP TABLE IF EXISTS "Redirect404Log";
DROP TABLE IF EXISTS "ResourceHandle";
DROP TABLE IF EXISTS "AuditSnapshot";
