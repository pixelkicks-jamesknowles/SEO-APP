-- AlterTable: multi-currency, lifecycle, Google Ads settings on TrackingSettings
ALTER TABLE "TrackingSettings" ADD COLUMN     "reportingCurrency" TEXT,
ADD COLUMN     "fxMode" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "lifecycleTracking" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "googleAdsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "googleAdsConfig" TEXT NOT NULL DEFAULT '{}';

-- CreateTable: durable retry queue
CREATE TABLE "DeliveryOutbox" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastDetail" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable: daily FX snapshot
CREATE TABLE "FxRate" (
    "base" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "rates" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("base","date")
);

-- CreateTable: per-shop alert dismissal
CREATE TABLE "AlertDismissal" (
    "shopDomain" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertDismissal_pkey" PRIMARY KEY ("shopDomain","kind")
);

-- CreateIndex
CREATE INDEX "DeliveryOutbox_status_nextAttemptAt_idx" ON "DeliveryOutbox"("status", "nextAttemptAt");
CREATE INDEX "DeliveryOutbox_shopDomain_idx" ON "DeliveryOutbox"("shopDomain");
