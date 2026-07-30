-- Auto-detect another on-page GA4 tag (Google & YouTube app) → auto-apply companion mode.
ALTER TABLE "TrackingSettings" ADD COLUMN "onPageGa4Detected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TrackingSettings" ADD COLUMN "onPageGa4DetectedAt" TIMESTAMP(3);
ALTER TABLE "TrackingSettings" ADD COLUMN "companionAuto" BOOLEAN NOT NULL DEFAULT true;
