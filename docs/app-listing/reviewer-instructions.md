# Reviewer test instructions — Pixel Kicks Tracking

Paste this into the "Testing instructions" field of the app submission. It lets a reviewer verify
the app with and without external credentials.

## What the app does (one line)
Sends Shopify storefront/checkout events server-side to GA4, Meta and server-side GTM, with consent
gating, subscription/refund tracking, SEO engagement events, bot filtering and delivery health.

## Demo store
- Store: [your demo dev store .myshopify.com]
- The app is already installed there. (Install link: [paste install link if needed].)

## Test 1 — see exactly what the app sends (no external accounts needed)
1. Open the app → **Event sandbox**.
2. Tick a few events (e.g. Purchase, Add to cart, Subscription) and a consent state, click **Preview output**.
3. Confirm it renders the GA4, Meta and GTM payloads. Nothing is sent — this is a safe preview.

## Test 2 — confirm events fire on the storefront (no external accounts needed)
1. App → **Tracking** → enable **Debug mode**, Save.
2. Visit the demo storefront, open DevTools → Console.
3. Browse a product / add to cart → see `[pixelify-tracking]` log lines proving events fire and
   respect consent.

## Test 3 — live server-side delivery to GA4 (uses a test GA4 property)
We provide a throwaway GA4 property for review:
- GA4 measurement ID: [G-XXXXXXXXXX]
- GA4 Measurement Protocol secret: [secret]

Steps:
1. App → **Tracking**: paste the GA4 measurement ID, tick events, turn on **Server-side delivery**, Save.
2. App → **Settings**: paste the GA4 secret, Save → click **Send test event**, **Send test purchase**,
   **Send test subscription**. Each should report success.
3. In GA4 → **Reports → Realtime** (or Admin → DebugView), see the `pixelify_test*` events arrive.
4. App → **Live events** shows the received events and a **Delivery health** panel (per-destination
   success). 

## Test 4 — real checkout (protected customer data path)
1. Put the demo store in test mode (Bogus Gateway).
2. Place a test order through checkout.
3. The `checkout_completed` pixel event + `orders/paid` webhook fire; the purchase (and, for a
   subscription product, the subscription event) appear in **Live events** and GA4 Realtime.

## Notes for the reviewer
- The app is **free** (no charges).
- It only sends data to destinations the merchant configures, using the merchant's own credentials.
- Customer PII (email/phone/name/address) is **hashed (SHA-256)** before being sent to Meta.
- GDPR webhooks (customers/redact, customers/data_request, shop/redact) are implemented.
- Emergency contact: [name + email].
