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
- **PII is hashed (SHA-256) before transmission** to Meta; we never send raw email/phone/name/address.
- We **do not build a customer database**. Storage is limited to: per-store settings; a rolling
  buffer of the 50 most recent events and 300 most recent delivery logs (diagnostics only); and a
  minimal first-touch attribution record (GA4 client id + UTM source/medium/campaign) keyed per
  customer for recurring-order attribution.
- Data is sent **only** to destinations the merchant explicitly configures with their own
  credentials. No data is shared with us for our own purposes, sold, or used for our advertising.
- **Consent-aware:** honours the Shopify Customer Privacy API; marketing destinations receive nothing
  without marketing consent (Consent Mode v2 sends modelled, non-identifying signals only).
- **Encryption in transit**; credentials/tokens stored securely with restricted staff access.
- **GDPR webhooks implemented:** customers/redact, customers/data_request, shop/redact.

## Retention & deletion
Diagnostics buffers self-prune (50 events / 300 logs per store). No long-term PII retention. Data is
removed on app uninstall or on a data-deletion request.
