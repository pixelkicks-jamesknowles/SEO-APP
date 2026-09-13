-- Count events that carried NO analytics-consent signal separately from those that were granted.
--
-- Why: analyticsConsented() treats unknown consent as granted, which is correct for DELIVERY (send the
-- event, flagged) but wrong for the Accuracy "consent rate" tile — a store running with Consent mode off
-- sends no consent object at all, so every event scored as granted and the tile read 100% with zero
-- denials. That is not a measurement, it is a default. The rate is now computed over granted + denied
-- only, with unknown surfaced in its own right.
ALTER TABLE "TrackingDaily" ADD COLUMN IF NOT EXISTS "consentUnknown" INTEGER NOT NULL DEFAULT 0;
