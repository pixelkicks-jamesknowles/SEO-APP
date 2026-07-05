-- CreateTable
CREATE TABLE "CronHeartbeat" (
    "scope" TEXT NOT NULL DEFAULT '_global',
    "lastTickAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "jobs" TEXT NOT NULL DEFAULT '{}',
    "errors" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronHeartbeat_pkey" PRIMARY KEY ("scope")
);
