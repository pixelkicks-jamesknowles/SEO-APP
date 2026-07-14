-- Companion mode: trim our GA4/sGTM sends to conversions only when the store also runs the Google &
-- YouTube app (which already sends page_view/view_item/etc), avoiding double-counted non-conversion events.
ALTER TABLE "TrackingSettings" ADD COLUMN "companionMode" BOOLEAN NOT NULL DEFAULT false;
