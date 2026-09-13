-- Track each customer's most recent subscription order + its cadence, so a lapsed-and-returned subscriber
-- can be distinguished from an ordinary renewal.
--
-- The app only ever sees ORDERS -- it subscribes to no subscription-contract webhooks and stores no
-- contract state -- so reactivation is inferred from the gap between subscription orders relative to the
-- billing interval. That is indicative, not exact: a PAUSED subscription that resumes looks identical to
-- a cancelled one that restarts. Exact separation needs contract-level data (Shopify
-- subscription_contracts/* or the Recharge API); see docs/specs/equaliser-sept2026-flag-accuracy.md.
--
-- Additive and nullable, so it is safe on a live table.
ALTER TABLE "CustomerAttribution" ADD COLUMN IF NOT EXISTS "lastSubscriptionOrderAt" TIMESTAMP(3);
ALTER TABLE "CustomerAttribution" ADD COLUMN IF NOT EXISTS "lastSubscriptionIntervalDays" INTEGER;
