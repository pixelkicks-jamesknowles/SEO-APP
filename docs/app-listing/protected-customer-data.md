# Protected Customer Data — reviewer justification

Use this to complete the Protected Customer Data questionnaire and to answer reviewer questions.

## What we access and why
| Data | Source | Why we need it |
| --- | --- | --- |
| Order data (line items, value, currency, transaction id) | `orders/paid`, `refunds/create`, `orders/cancelled` webhooks | To send server-side purchase, subscription and refund conversion events to the merchant's GA4 / Meta. |
| Customer email, phone, name, address | Checkout customer events + order webhooks | Hashed (SHA-256) and sent to Meta Conversions API as user_data to improve Event Match Quality. |
| fbp / fbc cookies, IP, user-agent | Storefront pixel beacon | Standard Meta CAPI match parameters. |

## Reasons selected
App functionality, Analytics, and Marketing or advertising — the App's sole purpose is delivering
the merchant's own conversion/analytics events to the merchant's own GA4, Meta and GTM destinations.

## How we protect it (data-minimisation)
- **No customer PII is stored at rest.** Identifiers are used only in transit; **hashed (SHA-256)
  before transmission** to Meta (we never send raw email/phone/name/address).
- The diagnostics buffer (50 most recent events) has email/phone/address/IP/cookies **redacted before
  storage**; the attribution record keys on a **hashed** email, never the raw address.
- We store **no raw customer PII** and **no marketing profiles**. Storage is limited to per-store
  settings; capped diagnostics (events + delivery logs); and **pseudonymous attribution/analytics data**
  keyed on a GA4 client_id, a customer id, or a **hashed** email:
  - first-touch source/medium/campaign and the touch path (GA4 client_id);
  - per-customer **aggregate** lifetime revenue + order count, for LTV/retention-by-channel (customer id / hashed email);
  - per-conversion order value + the touch path that led to it (order id).
  This is aggregate marketing attribution for the merchant's own reporting, not a customer profile store,
  and every row is purged on a customer-redaction or shop-redaction request (see below).
- Data is sent **only** to destinations the merchant explicitly configures with their own
  credentials. No data is shared with us for our own purposes, sold, or used for our advertising.
- **Consent-aware:** honours the Shopify Customer Privacy API; marketing destinations receive nothing
  without marketing consent (Consent Mode v2 sends modelled, non-identifying signals only).
- **Encryption in transit**; credentials/tokens stored securely with restricted staff access.
- **GDPR webhooks implemented:** customers/redact, customers/data_request, shop/redact.

## Retention & deletion
Diagnostics buffers self-prune (50 events / 300 logs per store). No long-term PII retention. On a
**customer-redaction** request we purge that customer's attribution, lifetime, conversion-path and
order-linked rows (by customer id, hashed email, and the orders in the request); on **shop redaction** /
uninstall we delete every shop-scoped table.
