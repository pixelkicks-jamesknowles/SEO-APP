import { useState } from "react";
import { Link } from "@remix-run/react";
import { Page, Card, BlockStack, Text, List, Banner, Box, Collapsible, Icon } from "@shopify/polaris";
import { ChevronDownIcon, ChevronUpIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

// Help content lives in one array so the page renders as a scannable accordion (titles + one-line
// summaries always visible; bodies expand on click) instead of one long scroll.
const SECTIONS = [
  {
    id: "overview",
    title: "What Pixel Kicks Tracking does",
    summary: "A free, server-side conversion + engagement tracker for any Shopify store.",
    body: (
      <>
        <Text as="p">
          It captures storefront and checkout events and delivers them server-side to GA4 (Measurement
          Protocol), Meta, TikTok, Pinterest, Snapchat and Reddit (Conversions APIs), Klaviyo (onsite
          events) and a server-side GTM container. On top of the standard events it adds subscription
          conversion tracking, refund / cancellation tracking, SEO engagement signals (scroll depth and
          engaged-content views), and an optional GTM web data layer — with bot filtering and
          per-destination delivery health built in.
        </Text>
        <Text as="p" tone="subdued">
          Because delivery is server-side, events keep flowing past ad blockers, Safari ITP and the
          checkout sandbox that breaks theme-based tracking.
        </Text>
      </>
    ),
  },
  {
    id: "how",
    title: "How it works",
    summary: "One first-party beacon to the app, then server-side fan-out to each destination.",
    body: (
      <List>
        <List.Item>
          The <b>web pixel</b> (Shopify Web Pixels API) subscribes to standard customer events, including
          checkout and purchase, which theme scripts can no longer reach.
        </List.Item>
        <List.Item>
          The <b>SEO engagement app embed</b> runs on the storefront and captures scroll depth and
          engaged-content views, which are not Shopify customer events.
        </List.Item>
        <List.Item>
          Both send one first-party beacon to the app proxy. <b>Bot filtering</b> drops known crawlers and
          headless agents, then the app forwards the event server-side to each destination you&apos;ve
          configured — GA4, Meta, TikTok, Pinterest, Snapchat, Reddit, Klaviyo and/or a server-side GTM
          container — using the credentials you store. In the strict pixel sandbox you cannot load gtag or
          fbq, so server-side is the delivery path.
        </List.Item>
        <List.Item>
          Optionally, the <b>GTM web data layer</b> (Pro) pushes GA4-standard + Elevar-compatible
          <code> dl_*</code> ecommerce events to <code>window.dataLayer</code> on your storefront, so your
          own GTM web container gets the browse funnel too. Purchase still comes server-side.
        </List.Item>
        <List.Item>
          Subscription conversions (orders/paid), refunds (refunds/create, orders/cancelled) and
          post-purchase lifecycle events (orders/edited, fulfillments/create) come from webhooks, not the
          pixel.
        </List.Item>
        <List.Item>
          Every server-side send is recorded, so <b>Delivery health</b> shows whether each destination is
          actually receiving data. A send that fails transiently is <b>retried automatically</b> with
          backoff, so a brief outage doesn&apos;t lose the conversion.
        </List.Item>
      </List>
    ),
  },
  {
    id: "notags",
    title: "Why Google Tag Assistant shows “no tags”",
    summary: "It’s expected — this app is server-side and puts nothing on the page.",
    body: (
      <>
        <Text as="p">
          Google Tag Assistant (and browser extensions that look for tags) will report <b>0 Google tags
          found</b> on your storefront. That is <b>expected and correct</b> - it is not a problem to fix.
        </Text>
        <Text as="p">
          The Shopify Web Pixel runs in a locked sandbox that cannot inject <b>gtag.js</b> or a GTM
          container onto the page, so this app delivers events <b>server to server</b> (GA4 Measurement
          Protocol, Meta CAPI). Tag Assistant only detects on-page, client-side tags - there are none here
          by design. That is exactly why the tracking survives ad blockers, Safari ITP and the checkout
          sandbox.
        </Text>
        <Text as="p" tone="subdued">
          To confirm events <i>are</i> flowing, don&apos;t look at Tag Assistant - use <b>GA4 DebugView</b>,
          the <Link to="/app/events">Live events</Link> page, or Debug mode. If a purchase lands in GA4 but
          page views don&apos;t, that&apos;s a <b>consent</b> question (see Consent below), not a tag one.
        </Text>
        <Text as="p" tone="subdued">
          <b>Exception:</b> if you turn on the <Link to="/app/datalayer">GTM data layer</Link>, the app
          <i> does</i> push events to <code>window.dataLayer</code> on your storefront — so Tag Assistant
          will then detect whatever tags your own GTM container fires from them. That&apos;s the one case
          where on-page tags are expected.
        </Text>
      </>
    ),
  },
  {
    id: "datalayer",
    title: "GTM data layer (optional, Pro)",
    summary: "Feed your own Google Tag Manager web container the browse funnel.",
    body: (
      <>
        <Text as="p">
          If you run your <b>own</b> GTM web container, enable the{" "}
          <Link to="/app/datalayer">GTM data layer</Link> and the storefront app embed will push the browse
          funnel to <code>window.dataLayer</code>: <code>view_item</code>, <code>view_item_list</code>,{" "}
          <code>add_to_cart</code>, <code>view_cart</code>, <code>begin_checkout</code> and{" "}
          <code>user_data</code>. Each fires twice — once in the GA4-standard shape and once as its
          Elevar-compatible <code>dl_*</code> mirror — so it works with GTM&apos;s built-in GA4 tags and
          with prebuilt Elevar containers alike.
        </Text>
        <Text as="p" tone="subdued">
          <b>Purchase is not in the page data layer</b> — Shopify&apos;s checkout is no longer themeable, so
          no app can push a <code>purchase</code> event there. Pixelify delivers the purchase conversion
          server-side (deduped &amp; reconciled); point your GA4 config at that, or run a server-side GTM
          container for it. Events are consent-gated and only fire once the toggle is on.
        </Text>
      </>
    ),
  },
  {
    id: "setup",
    title: "Setup checklist",
    summary: "The order to switch things on.",
    body: (
      <List type="number">
        <List.Item>
          On <Link to="/app/tracking">Tracking</Link>, enter your GA4, Meta and/or GTM IDs and tick which
          events each destination should receive.
        </List.Item>
        <List.Item>
          On <Link to="/app/settings">Settings</Link>, add the server-side credentials (GA4 Measurement
          Protocol secret, Meta CAPI token, and a server-side GTM container URL if you use GTM).
        </List.Item>
        <List.Item>
          Turn on <b>Server-side delivery</b> on the Tracking page. Keep <b>Consent mode</b> and{" "}
          <b>Bot filtering</b> on. Optionally enable <b>Subscription</b>, <b>Refund</b>, <b>Post-purchase
          &amp; lifecycle</b> and <b>multi-currency</b> normalization.
        </List.Item>
        <List.Item>
          For scroll and engaged-content events, enable the <b>Pixelify SEO engagement</b> app embed in
          Theme editor, App embeds, then tick those events on the Tracking page.
        </List.Item>
        <List.Item>
          Run <b><Link to="/app/wizard">Setup check</Link></b>: it confirms every required piece is in place
          and fires a live test event to each destination. Then watch them in GA4 Realtime / DebugView and
          on the Live events page.
        </List.Item>
      </List>
    ),
  },
  {
    id: "testing",
    title: "How to test",
    summary: "From safe preview to live verification.",
    body: (
      <List>
        <List.Item>
          <b><Link to="/app/wizard">Setup check</Link></b>: a one-screen checklist of everything required
          for delivery, plus a button to fire a live diagnostic event to GA4 and Meta (Meta uses a test
          event code so it shows under Test Events). Start here.
        </List.Item>
        <List.Item>
          <b><Link to="/app/sandbox">Event sandbox</Link></b>: preview the exact GTM dataLayer, GA4 and
          Meta payloads for any event (or several together), with different consent states. Nothing is
          sent, so it is safe to experiment and to build GTM tags against.
        </List.Item>
        <List.Item>
          <b>Settings verify buttons</b>: <i>Send test event</i> (a ping), <i>Send test purchase</i>{" "}
          (items + value), and <i>Send test subscription</i> (subscription + interval + items). Each
          validates against GA4, then delivers to <b>every configured destination</b> (GA4, Meta CAPI,
          server-side GTM) and logs the outcome to Delivery health, under a distinctly named event so it
          never pollutes real revenue. This verifies your credentials and the server-side pipeline - it
          does not test the storefront checkout capture (that needs a real checkout on a deployed store).
        </List.Item>
        <List.Item>
          <b>Debug mode</b> (Tracking page): logs every event to the storefront browser console. Open the
          storefront, then DevTools, Console, and look for “[pixelify-tracking]”. Confirms events fire and
          respect consent without configuring any destination.
        </List.Item>
        <List.Item>
          <b><Link to="/app/events">Live events</Link></b>: server-side events stream here as visitors
          trigger them, with expandable payloads, plus a <b>Delivery health (last 24h)</b> panel showing
          each destination&apos;s success / failure counts. See also{" "}
          <b><Link to="/app/accuracy">Accuracy</Link></b> for purchase-capture and delivery-success rates
          (and the retry queue), and <b><Link to="/app/attribution">Attribution</Link></b> for where your
          tracked visitors first came from.
        </List.Item>
        <List.Item>
          <b>GA4 DebugView / Realtime</b> and <b>Meta Test Events</b>: the source of truth. Note GA4 Admin
          → Events can lag ~24h, so check Realtime, not there.
        </List.Item>
        <List.Item>
          <b>Custom parameters</b> show in <b>Realtime</b> immediately, but only appear in <b>standard
          reports and Explore</b> after you register them as <b>Custom dimensions</b> (GA4 Admin → Custom
          definitions). That takes ~24-48h and is <b>not retroactive</b> - so a blank parameter dropdown on
          the standard Events report usually just means it is not registered yet, not that the data is
          missing. Standard fields (value, currency, transaction_id, items) need no setup. Worth
          registering: <b>subscription_interval</b>, <b>subscription</b>, <b>first_source</b>,
          {" "}<b>last_source</b>, <b>last_medium</b>, <b>last_campaign</b>, <b>touch_count</b>,
          {" "}<b>revenue</b> (raw revenue when margin mode is on), <b>original_value</b> /{" "}
          <b>original_currency</b> (the pre-conversion amount when multi-currency is on), and item-scoped{" "}
          <b>item_subscription</b> / <b>item_subscription_interval</b>.
        </List.Item>
      </List>
    ),
  },
  {
    id: "consent",
    title: "Consent (and Consent Mode v2)",
    summary: "How consent affects what is sent.",
    body: (
      <>
        <Text as="p">
          With Consent mode on, events respect the Customer Privacy API. <b>Analytics</b> and{" "}
          <b>marketing</b> consent are handled separately, the way Consent Mode v2 intends:
        </Text>
        <List>
          <List.Item>
            <b>Analytics consent</b> gates GA4 and GTM. Granted → a normal, cookie&apos;d hit, so the
            visitor shows as real traffic in GA4. A visitor who accepts analytics but declines marketing
            still counts in GA4.
          </List.Item>
          <List.Item>
            <b>Marketing consent</b> gates Meta, the ad-click identifiers (gclid, fbp/fbc) and any customer
            PII. Without it, Meta and Google Ads uploads are skipped.
          </List.Item>
          <List.Item>
            With <b>Consent Mode v2</b> on, a visitor who declines <i>analytics</i> still gets a
            privacy-safe, identifier-free flagged hit so GA4 can model the gap. Untick it for strict gating,
            where nothing fires until analytics consent is granted.
          </List.Item>
        </List>
        <Text as="p" tone="subdued">
          You can see exactly how each consent state changes the payload in the Event sandbox.
        </Text>
      </>
    ),
  },
  {
    id: "subscription",
    title: "Subscription conversion tracking",
    summary: "Recurring revenue GA4 normally never sees.",
    body: (
      <>
        <Text as="p">
          When enabled, a subscription order fires <b>two</b> server-side events to GA4: the regular{" "}
          <b>purchase</b> (the whole order - all items and full value, so revenue is complete) and a scoped{" "}
          <b>subscription_purchase</b> (the subscription line items only). subscription_purchase uses a
          distinct name so it never collides with the native purchase, and carries subscription /
          subscription_interval per order and per line, with the cadence read from the plan&apos;s delivery
          policy. Recurring orders inherit the first order&apos;s client_id and source/medium/campaign, so
          they keep their original attribution instead of looking like fresh direct traffic.
        </Text>
        <Text as="p" tone="subdued">
          To avoid double-counting, the pixel&apos;s GA4 purchase is suppressed for subscription orders
          (the webhook delivers it instead); Meta still fires from the pixel to keep its match quality.
        </Text>
        <Text as="p" fontWeight="semibold">
          Reporting subscription revenue in GA4
        </Text>
        <Text as="p">
          subscription_purchase&apos;s value is the discounted subscription amount and lands in GA4&apos;s{" "}
          <b>Event value</b> metric - it is deliberately <b>not</b> added to Total Revenue (that stays
          driven by <b>purchase</b>), so the subscription line is never counted twice.
        </Text>
        <List type="number">
          <List.Item>
            GA4 <b>Explore → Blank (Free form)</b>. Add dimension <b>Event name</b>, metrics <b>Event
            value</b> + <b>Event count</b>, and filter <i>Event name exactly matches</i>{" "}
            <b>subscription_purchase</b>. That is your subscription order count + revenue.
          </List.Item>
          <List.Item>
            To split by cadence, register <b>subscription_interval</b> as an event-scoped custom dimension
            (Admin → Custom definitions), then add it as a breakdown. Item-scoped <b>item_subscription</b> /{" "}
            <b>item_subscription_interval</b> work the same way.
          </List.Item>
          <List.Item>
            Optionally mark <b>subscription_purchase</b> as a <b>Key event</b> (Admin → Key events) to count
            it as a conversion in standard reports.
          </List.Item>
        </List>
      </>
    ),
  },
  {
    id: "refund",
    title: "Refund & cancellation tracking",
    summary: "Negative conversions so ads optimise correctly.",
    body: (
      <Text as="p">
        When enabled, a refund (refunds/create) or a cancelled order (orders/cancelled) fires a GA4{" "}
        <b>refund</b> event with the original transaction_id and the refunded value and items. GA4 nets it
        off the matching purchase, and through GA4 → Google Ads import that flows to Google Ads too - so
        campaigns stop optimising toward orders that get returned. A subscription refund additionally fires
        a <b>subscription_refund</b> reversing the subscription portion. Requires Server-side delivery;
        partial refunds send only the refunded line items.
      </Text>
    ),
  },
  {
    id: "lifecycle",
    title: "Post-purchase & lifecycle events",
    summary: "Keep analytics in sync when orders are edited or fulfilled.",
    body: (
      <Text as="p">
        When enabled, an <b>edited order</b> (orders/edited) fires an <b>order_edited</b> event carrying the
        order&apos;s new total, and a <b>fulfillment</b> (fulfillments/create) fires an{" "}
        <b>order_fulfilled</b> event. Both use distinct names and share the original{" "}
        <b>transaction_id</b>, so they add post-purchase visibility in GA4 <b>without</b> touching or
        double-counting the original purchase conversion. Requires Server-side delivery.
      </Text>
    ),
  },
  {
    id: "currency",
    title: "Multi-currency normalization",
    summary: "Optimise on comparable value across markets.",
    body: (
      <Text as="p">
        If you sell in multiple currencies, turn on <b>multi-currency</b> and set a <b>reporting
        currency</b> on the Tracking page. Every conversion&apos;s value is converted to that currency
        before delivery, so GA4, Meta and Google Ads all optimise on comparable numbers. The pre-conversion
        amount is preserved as <b>original_value</b> / <b>original_currency</b> params (register them as
        custom dimensions to report on them). Rates refresh daily; if a currency pair is unknown the raw
        amount is sent unchanged.
      </Text>
    ),
  },
  {
    id: "seo",
    title: "SEO engagement (scroll + engaged content)",
    summary: "On-site signals SEO teams care about.",
    body: (
      <Text as="p">
        Scroll depth and engaged-content views are not Shopify customer events, so they are captured by the{" "}
        <b>Pixelify SEO engagement</b> app embed (Theme editor → App embeds) and forwarded to GA4 / GTM as{" "}
        <b>scroll</b> (with percent_scrolled) and <b>engaged_view</b> events. Site search is sent as a
        complete GA4 <b>search</b> event with search_term. Enable the embed, then tick the engagement
        events on the Tracking page. These go to GA4 and GTM only, not Meta.
      </Text>
    ),
  },
  {
    id: "custom",
    title: "Custom & lead events",
    summary: "Track quote/RFQ, sample, finance and other non-standard conversions from your theme.",
    body: (
      <>
        <Text as="p">
          Beyond the standard events, your theme can fire arbitrary events - quote / RFQ, trade-account
          request, sample request, finance application, configurator - with a one-line call, delivered
          server-side to every configured destination. Requires the <b>Pixelify SEO engagement</b> app
          embed (it exposes the API) and <b>Server-side delivery</b> on. Call it on form submit / click:
        </Text>
        <Box background="bg-surface-secondary" padding="300" borderRadius="200">
          <Text as="p" fontWeight="medium" breakWord>
            {`window.pxp.track("generate_lead", { value: 50, currency: "GBP", form: "quote" })`}
          </Text>
        </Box>
        <List>
          <List.Item>
            <b>GA4</b>: fires an event with the name you pass - use a GA4 recommended name like{" "}
            <b>generate_lead</b>. Any params (value, currency, custom fields) come through; register custom
            params as custom dimensions to report on them.
          </List.Item>
          <List.Item>
            <b>Meta</b>: common lead names map to Meta standard events (generate_lead → Lead, sign_up →
            CompleteRegistration, contact → Contact); anything else fires as a Meta custom event of the
            same name.
          </List.Item>
          <List.Item>
            Consent and bot filtering apply. <b>Don&apos;t pass raw PII</b> (email/phone) in params.
          </List.Item>
        </List>
      </>
    ),
  },
  {
    id: "bots",
    title: "Bot filtering",
    summary: "Keeps fake conversions out of your ad platforms.",
    body: (
      <Text as="p">
        Bot filtering (on by default) drops known crawlers, headless browsers and monitoring agents before
        anything is recorded or delivered, so the 20-30% of traffic that is non-human never reaches your ad
        platforms as fake conversions. It applies to storefront pixel events; order webhooks (subscription,
        refund) are real orders and are never filtered.
      </Text>
    ),
  },
  {
    id: "delivery",
    title: "Delivery health",
    summary: "Proof that each destination is receiving data.",
    body: (
      <BlockStack gap="200">
        <Text as="p">
          Every server-side send is logged with its outcome. The <Link to="/app/events">Live events</Link>{" "}
          page shows a <b>Delivery health (last 24h)</b> panel - green when a destination is receiving
          everything, red with a failure count when something is wrong (for example a bad Meta token). The
          Home and <Link to="/app/accuracy">Accuracy</Link> pages surface health alerts too.
        </Text>
        <Text as="p">
          A send that fails is <b>queued and retried automatically</b> with increasing backoff (up to
          several attempts over ~15 hours), so a transient outage or a slow destination doesn&apos;t lose
          the conversion. The <b>Retry queue</b> stat on Accuracy shows how many are waiting; if events
          exhaust every retry they&apos;re marked failed and flagged there - almost always a credential to
          fix on Settings.
        </Text>
      </BlockStack>
    ),
  },
  {
    id: "channel",
    title: "Why purchases must not show as “Unassigned”",
    summary: "How server-side conversions keep their GA4 channel.",
    body: (
      <BlockStack gap="200">
        <Text as="p">
          GA4 works out a conversion&apos;s <b>channel</b> from the session it belongs to. A server-side
          purchase therefore has to carry the shopper&apos;s <b>real GA4 client_id and session_id</b>; if it
          doesn&apos;t, GA4 opens a brand-new session with no traffic source and the purchase reports as{" "}
          <b>Unassigned</b>.
        </Text>
        <Text as="p">
          The <b>Pixelify SEO engagement</b> app embed handles this: it reads the shopper&apos;s GA4 cookies
          and writes them onto the cart, so they arrive on the order. The purchase we send from{" "}
          <code>orders/paid</code> (and any reconciliation backfill) then reuses that same pair, and GA4
          attaches the conversion to the real session, keeping the channel.
        </Text>
        <Text as="p" tone="subdued">
          So the embed <b>must be enabled</b> in the theme, or webhook-driven conversions (subscription
          orders especially) will lose their channel. Note a recurring renewal has no browser session at all,
          so it can&apos;t inherit one — that&apos;s a GA4 limitation, not a gap in the app.
        </Text>
      </BlockStack>
    ),
  },
  {
    id: "worker",
    title: "Background worker status",
    summary: "How you know the scheduled worker that retries and reconciles is alive.",
    body: (
      <BlockStack gap="200">
        <Text as="p">
          Several things happen on a schedule rather than the instant an event arrives: retrying failed
          sends, backfilling any purchase the pixel missed (reconciliation), delivering subscription
          conversions, refreshing exchange rates and pushing health alerts. These are driven by a{" "}
          <b>background worker</b> (a scheduled call to <code>/cron/tick</code>).
        </Text>
        <Text as="p">
          The <Link to="/app">Home</Link> page shows a <b>Worker</b> badge with when it last ran. Green means
          it&apos;s healthy; amber (<b>lagging</b>) means it hasn&apos;t run in a little while; red
          (<b>stopped</b>) means it hasn&apos;t run for long enough that retries and reconciliation have
          likely stalled - and a health alert is raised (in-app, and to your alert webhook if set). If you
          see it stopped, check that the scheduled cron service is running and that its <code>CRON_SECRET</code>{" "}
          matches - see the deploy runbook.
        </Text>
        <Text as="p" tone="subdued">
          On a brand-new install the badge reads &ldquo;awaiting first run&rdquo; until the worker ticks for
          the first time - that&apos;s expected, not an error.
        </Text>
      </BlockStack>
    ),
  },
  {
    id: "doublecount",
    title: "Avoiding double-counting with the Google & YouTube app",
    summary: "How this app coexists with native GA4 / Google Ads tracking.",
    body: (
      <BlockStack gap="200">
        <Text as="p">
          If the store runs the native Google &amp; YouTube app, it already sends the standard GA4
          ecommerce events, including <b>purchase</b>. Server-side events here de-dup safely: GA4 collapses
          purchases on matching <b>transaction_id</b> and Meta de-dups on <b>event_id</b>. For other
          events, prefer to track here only what the native app does not already send.
        </Text>
        <Text as="p">
          <b>Google Ads:</b> the simplest path needs no setup here - the server-side GA4 purchase carries
          the right client_id, so it stitches to the on-page session that holds the gclid; link your GA4
          property to Google Ads and import the purchase conversion. If you&apos;d rather upload conversions
          straight to Google Ads, see <b>Google Ads Enhanced Conversions</b> below (optional).
        </Text>
        <Text as="p">
          <b>GTM:</b> a web container (GTM-XXXX) cannot load in the pixel sandbox, so GTM events are
          delivered to your server-side GTM container. Add its URL on the Settings page.
        </Text>
      </BlockStack>
    ),
  },
  {
    id: "googleads",
    title: "Google Ads Enhanced Conversions (optional)",
    summary: "Upload purchases straight to Google Ads, not just via GA4 import.",
    body: (
      <Text as="p">
        As an alternative to the GA4 → Google Ads import path, purchases can be <b>uploaded directly</b> to
        Google Ads, matched on the on-page <b>gclid</b> and/or hashed customer data (Enhanced Conversions).
        This is <b>optional and off unless enabled by your app operator</b>; when available, the{" "}
        <b>Google Ads</b> section appears on the <Link to="/app/settings">Settings</Link> page - connect
        your Google account, then set your customer ID and conversion action. Failed uploads retry
        automatically like every other destination.
      </Text>
    ),
  },
];

function AccordionSection({ id, title, summary, open, onToggle, children }) {
  return (
    <Card padding="0">
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        aria-controls={`help-${id}`}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          margin: 0,
          padding: "var(--p-space-400)",
          cursor: "pointer",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--p-space-300)", width: "100%" }}>
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">{title}</Text>
            <Text as="p" tone="subdued" variant="bodySm">{summary}</Text>
          </BlockStack>
          <span style={{ flexShrink: 0, display: "inline-flex" }}>
            <Icon source={open ? ChevronUpIcon : ChevronDownIcon} tone="subdued" />
          </span>
        </div>
      </button>
      <Collapsible open={open} id={`help-${id}`} transition={{ duration: "150ms", timingFunction: "ease-in-out" }}>
        <Box paddingInline="400" paddingBlockEnd="400">
          <BlockStack gap="300">{children}</BlockStack>
        </Box>
      </Collapsible>
    </Card>
  );
}

export default function Help() {
  const [openIds, setOpenIds] = useState(() => new Set([SECTIONS[0].id]));
  const toggle = (id) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <Page
      title="Help"
      subtitle="What this app does, how it delivers events, and how to test before you trust the data."
      secondaryActions={[
        { content: "Expand all", onAction: () => setOpenIds(new Set(SECTIONS.map((s) => s.id))) },
        { content: "Collapse all", onAction: () => setOpenIds(new Set()) },
      ]}
    >
      <BlockStack gap="300">
        {SECTIONS.map((s) => (
          <AccordionSection key={s.id} id={s.id} title={s.title} summary={s.summary} open={openIds.has(s.id)} onToggle={toggle}>
            {s.body}
          </AccordionSection>
        ))}

        <Banner tone="info">
          Still stuck? The Event sandbox shows precisely what the app would send, Debug mode confirms what
          fires on the storefront, and Delivery health shows what actually landed. Between them you can
          diagnose almost any tracking question without guessing.
        </Banner>
        <Box paddingBlockEnd="400" />
      </BlockStack>
    </Page>
  );
}
