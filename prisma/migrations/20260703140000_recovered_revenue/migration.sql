-- Recovered-revenue counters on the daily rollup: purchases the storefront pixel never captured that
-- the reconciliation pass backfilled server-side, and their summed order value. Additive + default-
-- valued, so this is non-locking with no backfill.
ALTER TABLE "TrackingDaily" ADD COLUMN "purchasesRecovered" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TrackingDaily" ADD COLUMN "revenueRecovered" DOUBLE PRECISION NOT NULL DEFAULT 0;
