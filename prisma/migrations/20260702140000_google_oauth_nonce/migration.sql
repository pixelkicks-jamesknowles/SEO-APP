-- Single-use, short-TTL nonce for the Google Ads OAuth `state` (CSRF + replay protection).
-- Nullable + no default: additive, non-locking, no backfill.
ALTER TABLE "Shop" ADD COLUMN "googleOauthNonce" TEXT;
ALTER TABLE "Shop" ADD COLUMN "googleOauthNonceExpiresAt" TIMESTAMP(3);
