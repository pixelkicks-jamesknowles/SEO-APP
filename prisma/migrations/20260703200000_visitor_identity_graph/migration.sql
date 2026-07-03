-- Identity graph: links the durable first-party id (pxp_id) to the GA4 client id it was last seen with
-- and to a customer once the visitor identifies, so tracking is per-person (cross-session/device) rather
-- than per-session. New standalone table + two indexes — additive, non-locking, no backfill.
CREATE TABLE "VisitorIdentity" (
    "shopDomain" TEXT NOT NULL,
    "durableId" TEXT NOT NULL,
    "clientId" TEXT,
    "customerKey" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitorIdentity_pkey" PRIMARY KEY ("shopDomain","durableId")
);

CREATE INDEX "VisitorIdentity_shopDomain_customerKey_idx" ON "VisitorIdentity"("shopDomain", "customerKey");
