-- Feature suite: purchase reconciliation, match-quality diagnostics, TikTok/Pinterest destinations.
-- All additive (new columns default-valued, new tables) so this is non-locking with no backfill.

-- Reconciliation toggle (on by default; only acts when serverSide is on).
ALTER TABLE "TrackingSettings" ADD COLUMN "reconciliation" BOOLEAN NOT NULL DEFAULT true;

-- Reconciliation queue: one row per paid order, carrying the pre-built (Meta-hashed) GA4/Meta jobs.
CREATE TABLE "PendingPurchase" (
    "shopDomain" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PendingPurchase_pkey" PRIMARY KEY ("shopDomain","orderId")
);
CREATE INDEX "PendingPurchase_status_createdAt_idx" ON "PendingPurchase"("status", "createdAt");

-- Which destinations already delivered a purchase for an order (so reconcile fills only the gaps).
CREATE TABLE "PurchaseCapture" (
    "shopDomain" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ga4" BOOLEAN NOT NULL DEFAULT false,
    "meta" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseCapture_pkey" PRIMARY KEY ("shopDomain","orderId")
);
CREATE INDEX "PurchaseCapture_shopDomain_at_idx" ON "PurchaseCapture"("shopDomain", "at");

-- Per-day Meta identifier-coverage counters for the match-quality diagnostics.
CREATE TABLE "MatchQualityDaily" (
    "shopDomain" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "em" INTEGER NOT NULL DEFAULT 0,
    "ph" INTEGER NOT NULL DEFAULT 0,
    "fn" INTEGER NOT NULL DEFAULT 0,
    "ln" INTEGER NOT NULL DEFAULT 0,
    "ct" INTEGER NOT NULL DEFAULT 0,
    "st" INTEGER NOT NULL DEFAULT 0,
    "zp" INTEGER NOT NULL DEFAULT 0,
    "country" INTEGER NOT NULL DEFAULT 0,
    "externalId" INTEGER NOT NULL DEFAULT 0,
    "fbp" INTEGER NOT NULL DEFAULT 0,
    "fbc" INTEGER NOT NULL DEFAULT 0,
    "clientIp" INTEGER NOT NULL DEFAULT 0,
    "userAgent" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MatchQualityDaily_pkey" PRIMARY KEY ("shopDomain","date")
);
