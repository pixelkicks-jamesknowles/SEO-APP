-- CreateTable
CREATE TABLE "BackfillJob" (
    "shopDomain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "cursor" TEXT,
    "sinceDate" TEXT,
    "ordersProcessed" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackfillJob_pkey" PRIMARY KEY ("shopDomain")
);
