-- AlterTable
ALTER TABLE "TrackingSettings" ADD COLUMN     "subscriptionConfig" TEXT NOT NULL DEFAULT '{}',
ADD COLUMN     "subscriptionTracking" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "webhookId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhook_pkey" PRIMARY KEY ("webhookId")
);

-- CreateIndex
CREATE INDEX "ProcessedWebhook_shopDomain_at_idx" ON "ProcessedWebhook"("shopDomain", "at");
