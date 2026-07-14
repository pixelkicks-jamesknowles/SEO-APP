-- Deep-scan window for the backfill: page orders from `historySince` (years back, to LEARN each
-- customer's acquiring channel) while still only aggregating REVENUE from `sinceDate` onward.
ALTER TABLE "BackfillJob" ADD COLUMN "historySince" TEXT;
