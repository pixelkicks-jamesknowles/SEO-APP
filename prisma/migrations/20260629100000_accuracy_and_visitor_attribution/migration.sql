-- CreateTable
CREATE TABLE "TrackingDaily" (
    "shopDomain" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "ordersPaid" INTEGER NOT NULL DEFAULT 0,
    "purchasesDelivered" INTEGER NOT NULL DEFAULT 0,
    "eventsSent" INTEGER NOT NULL DEFAULT 0,
    "eventsFailed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingDaily_pkey" PRIMARY KEY ("shopDomain","date")
);

-- CreateTable
CREATE TABLE "VisitorAttribution" (
    "shopDomain" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "source" TEXT,
    "medium" TEXT,
    "campaign" TEXT,
    "visits" INTEGER NOT NULL DEFAULT 1,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitorAttribution_pkey" PRIMARY KEY ("shopDomain","clientId")
);
