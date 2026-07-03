-- Proactive health alerting: an incoming-webhook URL the cron posts tracking-health alerts to, plus a
-- per-(shop, kind) notify-dedup table so a still-firing alert isn't re-sent every tick. Additive column
-- (nullable, no default) + a new standalone table — non-locking, no backfill.
ALTER TABLE "TrackingSettings" ADD COLUMN "alertWebhookUrl" TEXT;

CREATE TABLE "AlertNotification" (
    "shopDomain" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertNotification_pkey" PRIMARY KEY ("shopDomain","kind")
);
