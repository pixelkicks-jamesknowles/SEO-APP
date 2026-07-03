-- Reddit Conversions API destination: the pixel/advertiser id used in the events endpoint path. The
-- Reddit access token lives (encrypted) in TrackingSettings.serverSideKeys. Snapchat reuses the existing
-- snapPixelId column, so only Reddit needs a new one. Additive + nullable → non-locking, no backfill.
ALTER TABLE "TrackingSettings" ADD COLUMN "redditPixelId" TEXT;
