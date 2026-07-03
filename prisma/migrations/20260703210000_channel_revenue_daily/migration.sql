-- Per-day revenue attributed to a first-touch acquisition channel, for the "Revenue by channel" table on
-- the Attribution page. Bumped once per pixel-captured checkout_completed. New standalone table + index —
-- additive, non-locking, no backfill.
CREATE TABLE "ChannelRevenueDaily" (
    "shopDomain" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "medium" TEXT NOT NULL,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelRevenueDaily_pkey" PRIMARY KEY ("shopDomain","date","source","medium")
);

CREATE INDEX "ChannelRevenueDaily_shopDomain_date_idx" ON "ChannelRevenueDaily"("shopDomain", "date");
