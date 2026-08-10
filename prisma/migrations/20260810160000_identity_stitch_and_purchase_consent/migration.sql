-- Order-level analytics-consent split (Accuracy "orders opted out of tracking" tile).
ALTER TABLE "TrackingDaily" ADD COLUMN "purchaseConsentGranted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TrackingDaily" ADD COLUMN "purchaseConsentDenied" INTEGER NOT NULL DEFAULT 0;

-- Cross-channel identity stitch: attach a customerKey to durable identities sharing a GA client id.
CREATE INDEX "VisitorIdentity_shopDomain_clientId_idx" ON "VisitorIdentity"("shopDomain","clientId");
