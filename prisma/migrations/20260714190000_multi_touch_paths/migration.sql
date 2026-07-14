-- Multi-touch attribution: full touch path on the visitor + a per-conversion path snapshot.
ALTER TABLE "VisitorAttribution" ADD COLUMN "touches" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE "ConversionPath" (
    "shopDomain" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "visitorKey" TEXT,
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conversionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "touches" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "ConversionPath_pkey" PRIMARY KEY ("shopDomain","orderId")
);
CREATE INDEX "ConversionPath_shopDomain_conversionAt_idx" ON "ConversionPath"("shopDomain", "conversionAt");
