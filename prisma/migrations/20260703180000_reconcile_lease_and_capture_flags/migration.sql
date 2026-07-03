-- Reconcile-pass compare-and-swap lease (mirrors the DeliveryOutbox lease), so two overlapping cron
-- ticks can't both backfill — and double-count the recovered revenue of — the same pending order.
-- Nullable + no default: additive, non-locking, no backfill.
ALTER TABLE "PendingPurchase" ADD COLUMN "leaseToken" TEXT;
ALTER TABLE "PendingPurchase" ADD COLUMN "leasedUntil" TIMESTAMP(3);

-- Per-destination capture flags for the two destinations added to the reconcile backfill (Google Ads,
-- Reddit — both have reliable server-side dedup). Default false + NOT NULL, so existing rows read as
-- "not yet captured"; additive and non-locking.
ALTER TABLE "PurchaseCapture" ADD COLUMN "googleAds" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PurchaseCapture" ADD COLUMN "reddit" BOOLEAN NOT NULL DEFAULT false;
