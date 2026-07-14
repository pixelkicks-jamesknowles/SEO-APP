# Privacy Policy — Pixel Kicks Tracking

_Last updated: [DATE]_

This policy explains what data the Pixel Kicks Tracking app ("the App", "we") processes when
installed on a Shopify store, and why. Fill the `[…]` placeholders and host this page at a public
URL, then enter that URL in the app listing.

**Provider:** [Legal entity, e.g. PushON Ltd] ("we")
**Contact:** [privacy contact email]

## What the App does
The App forwards a store's analytics and conversion events to the destinations the merchant
configures (Google Analytics 4, Meta Conversions API, and/or a server-side Google Tag Manager
container). Events are delivered server-side using credentials the merchant provides.

## Data we process
We act as a data processor on behalf of the merchant. We process:

- **Store & configuration data:** shop domain, the merchant's destination IDs (GA4 measurement ID,
  Meta Pixel ID, GTM/container), and the API credentials the merchant enters (GA4 Measurement
  Protocol secret, Meta CAPI token). Stored to operate the integration.
- **Storefront events:** standard Shopify customer events (page, product, cart, search, checkout,
  purchase) captured via Shopify's Web Pixels API, plus scroll/engagement signals from the app's
  theme extension.
- **Order data:** from `orders/paid`, `refunds/create` and `orders/cancelled` webhooks, used to send
  subscription and refund conversion events.
- **Customer identifiers used for ad matching:** email, phone, name and address, plus the `fbp`/`fbc`
  cookies and IP/user-agent. Email, phone, name and address are **hashed (SHA-256)** before being
  sent to Meta. We do not store these identifiers as a standalone customer database.
- **Shopify session tokens:** stored securely to authenticate API calls; never shared.

## How we use it
Solely to deliver the events to the merchant's own configured destinations (GA4, Meta, GTM). We do
not sell data, do not use it for our own advertising, and do not share it with any third party other
than the destinations the merchant configures.

## Consent
The App honours the Shopify Customer Privacy (consent) API. With consent gating on, marketing
destinations receive no data without marketing consent; with Consent Mode v2, consent-flagged
signals are sent so analytics platforms can model conversions appropriately.

## Sub-processors / recipients
- The destinations the merchant configures: Google (GA4 / GTM), Meta. Data is sent to these on the
  merchant's instruction and is then governed by the merchant's relationship with those providers.
- Our hosting/infrastructure provider: [hosting provider, e.g. Railway] (compute + database).

## Retention & data minimisation
We do **not store customer PII at rest**. Customer identifiers (email, phone, name, address, IP) are
used only in transit to deliver events, and are hashed (SHA-256) before being sent to Meta. The
diagnostics buffer of recent events (capped at 50 per store) has these identifiers **redacted** before
storage, and any attribution record keys on a customer id or a **hashed** email, never the raw address.
Beyond per-store settings and capped diagnostics, we retain **pseudonymous marketing-attribution data**
for the merchant's own reporting: first-touch source/medium/campaign and touch paths (keyed on a GA4
client_id), per-customer **aggregate** lifetime revenue and order counts, and per-conversion order value
plus the touch path that led to it. This is aggregate attribution, not a customer profile. On uninstall
or a redaction request, this data is deleted — a customer-redaction request purges that customer's rows;
shop redaction deletes every shop-scoped table.

## GDPR / data subject requests
We support Shopify's mandatory compliance webhooks: customer data request, customer redaction, and
shop redaction. Requests are actioned on receipt.

## Security
Data is encrypted in transit. Credentials and tokens are stored securely with restricted access.

## Your rights / contact
Merchants and their customers can contact [privacy contact email] for access, correction or
deletion requests. Merchants remain the data controller for their customers' data.
