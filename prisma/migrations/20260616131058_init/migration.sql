-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "shopDomain" TEXT NOT NULL,
    "offlineToken" TEXT,
    "plan" TEXT,
    "subscriptionGid" TEXT,
    "billingStatus" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("shopDomain")
);

-- CreateTable
CREATE TABLE "SeoSettings" (
    "shopDomain" TEXT NOT NULL,
    "metaTemplates" TEXT NOT NULL DEFAULT '{}',
    "altTemplate" TEXT,
    "schemaToggles" TEXT NOT NULL DEFAULT '{}',
    "suppressedNodes" TEXT NOT NULL DEFAULT '[]',
    "organization" TEXT NOT NULL DEFAULT '{}',
    "robotsRules" TEXT,
    "llmsTxtEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoSettings_pkey" PRIMARY KEY ("shopDomain")
);

-- CreateTable
CREATE TABLE "TrackingSettings" (
    "shopDomain" TEXT NOT NULL,
    "gtmId" TEXT,
    "ga4Id" TEXT,
    "metaPixelId" TEXT,
    "tiktokPixelId" TEXT,
    "eventMatrix" TEXT NOT NULL DEFAULT '{}',
    "consentMode" BOOLEAN NOT NULL DEFAULT true,
    "serverSide" BOOLEAN NOT NULL DEFAULT false,
    "serverSideKeys" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingSettings_pkey" PRIMARY KEY ("shopDomain")
);

-- CreateTable
CREATE TABLE "Redirect404Log" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "suggestedTarget" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Redirect404Log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Redirect404Log_shopDomain_resolved_idx" ON "Redirect404Log"("shopDomain", "resolved");

-- CreateIndex
CREATE UNIQUE INDEX "Redirect404Log_shopDomain_path_key" ON "Redirect404Log"("shopDomain", "path");
