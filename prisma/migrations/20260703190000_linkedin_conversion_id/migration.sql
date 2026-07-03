-- LinkedIn Conversions API: the conversion-rule id (the access token lives encrypted in
-- TrackingSettings.serverSideKeys). Nullable + no default → additive, non-locking, no backfill.
ALTER TABLE "TrackingSettings" ADD COLUMN "linkedinConversionId" TEXT;
