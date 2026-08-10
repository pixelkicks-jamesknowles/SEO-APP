-- New-vs-returning / subscription-vs-one-off acquisition rollup, split by channel + campaign. Written from
-- orders/paid alongside ChannelRevenueDaily; powers the "New vs returning, by channel and campaign" report.
CREATE TABLE "AcquisitionDaily" (
    "shopDomain" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "medium" TEXT NOT NULL,
    "campaign" TEXT NOT NULL DEFAULT '(none)',
    "orderType" TEXT NOT NULL DEFAULT 'one_off',
    "customerType" TEXT NOT NULL DEFAULT '(unknown)',
    "orders" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AcquisitionDaily_pkey" PRIMARY KEY ("shopDomain","date","source","medium","campaign","orderType","customerType")
);
CREATE INDEX "AcquisitionDaily_shopDomain_date_idx" ON "AcquisitionDaily"("shopDomain","date");

-- Historical attribution write-back job: stamp connect_analytics.* metafields onto past orders. Resumable +
-- leased exactly like BackfillJob.
CREATE TABLE "MetafieldBackfillJob" (
    "shopDomain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "cursor" TEXT,
    "historySince" TEXT,
    "ordersProcessed" INTEGER NOT NULL DEFAULT 0,
    "metafieldsWritten" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetafieldBackfillJob_pkey" PRIMARY KEY ("shopDomain")
);
