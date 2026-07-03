-- CreateTable
CREATE TABLE "PendingSubscription" (
    "shopDomain" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detail" TEXT,
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingSubscription_pkey" PRIMARY KEY ("shopDomain","orderId")
);

-- CreateIndex
CREATE INDEX "PendingSubscription_status_createdAt_idx" ON "PendingSubscription"("status", "createdAt");
