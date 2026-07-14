-- Split subscription revenue out of the per-channel daily rollup.
--
-- Recurring subscription renewals never fire a storefront checkout, so GA4 can never give them a session
-- channel (no browser session to inherit a source from — they report as "Unassigned" forever). The app
-- CAN: orders/paid sees every paid order and replays the customer's first-touch source onto the renewal.
-- These two columns let the Attribution report answer "which channel actually drove our subscription
-- revenue". One-off revenue = revenue - subscriptionRevenue.
--
-- Additive, NOT NULL with defaults → no backfill, no table rewrite, non-locking.
ALTER TABLE "ChannelRevenueDaily" ADD COLUMN "subscriptionOrders" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChannelRevenueDaily" ADD COLUMN "subscriptionRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0;
