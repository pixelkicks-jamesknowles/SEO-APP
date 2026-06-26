-- AlterTable
ALTER TABLE "TrackingSettings" ADD COLUMN     "botFiltering" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "refundTracking" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DeliveryLog" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryLog_shopDomain_createdAt_idx" ON "DeliveryLog"("shopDomain", "createdAt");
