-- Per-day analytics-consent counters for the Accuracy "consent rate".
ALTER TABLE "TrackingDaily" ADD COLUMN "consentGranted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TrackingDaily" ADD COLUMN "consentDenied" INTEGER NOT NULL DEFAULT 0;
