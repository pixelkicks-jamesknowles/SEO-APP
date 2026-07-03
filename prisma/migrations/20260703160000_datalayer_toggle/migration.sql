-- GTM web-container data layer (Pro feature). The theme app embed pushes GA4 + Elevar-compatible dl_*
-- ecommerce events to window.dataLayer when this is on. Gated behind requirePro at toggle time; the
-- storefront reads the effective flag from the app-proxy /config endpoint. Additive + default false.
ALTER TABLE "TrackingSettings" ADD COLUMN "dataLayerEnabled" BOOLEAN NOT NULL DEFAULT false;
