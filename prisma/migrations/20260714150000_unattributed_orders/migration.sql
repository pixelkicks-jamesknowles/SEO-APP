-- Per-order (unattributed) list, so the report can list/export them and split migrated-in from lost.
CREATE TABLE "UnattributedOrder" (
    "shopDomain" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT,
    "date" TEXT NOT NULL,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isSubscription" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "migrated" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "customerKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UnattributedOrder_pkey" PRIMARY KEY ("shopDomain","orderId")
);
CREATE INDEX "UnattributedOrder_shopDomain_date_idx" ON "UnattributedOrder"("shopDomain", "date");
