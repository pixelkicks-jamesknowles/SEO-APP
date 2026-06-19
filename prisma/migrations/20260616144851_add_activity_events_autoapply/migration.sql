-- AlterTable
ALTER TABLE "SeoSettings" ADD COLUMN     "autoApply" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecentEvent" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityLog_shopDomain_createdAt_idx" ON "ActivityLog"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "RecentEvent_shopDomain_createdAt_idx" ON "RecentEvent"("shopDomain", "createdAt");
