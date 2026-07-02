-- AlterTable
ALTER TABLE "TrackingSettings" ADD COLUMN     "valueMode" TEXT NOT NULL DEFAULT 'revenue',
ADD COLUMN     "marginPct" INTEGER NOT NULL DEFAULT 0;
