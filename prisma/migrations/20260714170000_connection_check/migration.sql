-- Scheduled connection-verification result per destination (GA4 validated on a cadence via the debug
-- endpoint, which does not ingest). A failing row becomes a health alert via computeHealth.
CREATE TABLE "ConnectionCheck" (
    "shopDomain" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "detail" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectionCheck_pkey" PRIMARY KEY ("shopDomain","destination")
);
