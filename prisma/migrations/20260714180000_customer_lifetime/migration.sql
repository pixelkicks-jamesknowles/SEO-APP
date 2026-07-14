-- Per-customer lifetime totals for LTV / retention by channel (backfill-populated, joined to
-- CustomerAttribution at report time). Reset on a fresh backfill; increment-safe under the page transaction.
CREATE TABLE "CustomerLifetime" (
    "shopDomain" TEXT NOT NULL,
    "customerKey" TEXT NOT NULL,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "firstOrderAt" TEXT,
    "lastOrderAt" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerLifetime_pkey" PRIMARY KEY ("shopDomain","customerKey")
);
CREATE INDEX "CustomerLifetime_shopDomain_idx" ON "CustomerLifetime"("shopDomain");
