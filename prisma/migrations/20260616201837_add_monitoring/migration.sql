-- AlterTable
ALTER TABLE "SeoSettings" ADD COLUMN     "alertWebhook" TEXT,
ADD COLUMN     "monitoring" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AuditSnapshot" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "issues" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditSnapshot_shopDomain_createdAt_idx" ON "AuditSnapshot"("shopDomain", "createdAt");
