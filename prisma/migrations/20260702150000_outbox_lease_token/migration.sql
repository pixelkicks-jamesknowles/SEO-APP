-- Per-drain claim token for the outbox worker, so two overlapping cron ticks can't process the same
-- row (compare-and-swap lease). Nullable + no default: additive, non-locking, no backfill.
ALTER TABLE "DeliveryOutbox" ADD COLUMN "leaseToken" TEXT;
