-- AlterTable
ALTER TABLE "TrackingSettings" ADD COLUMN     "consentSignals" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CustomerAttribution" (
    "shopDomain" TEXT NOT NULL,
    "customerKey" TEXT NOT NULL,
    "clientId" TEXT,
    "source" TEXT,
    "medium" TEXT,
    "campaign" TEXT,
    "firstOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAttribution_pkey" PRIMARY KEY ("shopDomain","customerKey")
);
