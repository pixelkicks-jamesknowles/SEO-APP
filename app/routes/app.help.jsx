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
          Protocol), Meta (Conversions API) and a server-side GTM container. On top of the standard events
          it adds subscription conversion tracking, refund / cancellation tracking, and SEO engagement
          signals (scroll depth and engaged-content views) - with bot filtering and per-destination
          delivery health built in.
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
          headless agents, then the app forwards the event server-side to GA4 / Meta / server-side GTM
          using the credentials you store. In the strict pixel sandbox you cannot load gtag or fbq, so
          server-side is the delivery path.
        </List.Item>
        <List.Item>
          Subscription conversions (orders/paid) and refunds (refunds/create, orders/cancelled) come from
          webhooks, not the pixel.
        </List.Item>
        <List.Item>
          Every server-side send is recorded, so <b>Delivery health</b> shows whether each destination is
          actually receiving data.
        </List.Item>
      </List>
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
          <b>Bot filtering</b> on. Optionally enable <b>Subscription</b> and <b>Refund</b> tracking.
        </List.Item>
        <List.Item>
          For scroll and engaged-content events, enable the <b>Pixelify SEO engagement</b> app embed in
          Theme editor, App embeds, then tick those events on the Tracking page.
        </List.Item>
        <List.Item>
          Verify on Settings with <b>Send GA4 test event / purchase / subscription</b>, then watch them in
          GA4 Realtime / DebugView and on the Live events page.
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
          <b><Link to="/app/accuracy">Accuracy</Link></b> for purchase-capture and delivery-success rates.
        </List.Item>
        <List.Item>
          <b>GA4 DebugView / Realtime</b> and <b>Meta Test Events</b>: the source of truth. Note GA4 Admin
          → Events can lag ~24h, so check Realtime, not there.
        </List.Item>
        <List.Item>
          <b>Custom parameters</b> (subscription_interval, source/medium/campaign, item_subscription, etc.)
          show in <b>Realtime</b> immediately, but only appear in <b>standard reports and Explore</b> after
          you register them as <b>Custom dimensions</b> (GA4 Admin → Custom definitions). That takes
          ~24-48h and is <b>not retroactive</b> - so a blank parameter dropdown on the standard Events
          report usually just means it is not registered yet, not that the data is missing. Standard fields
          (value, currency, transaction_id, items) need no setup.
        </List.Item>
      </List>
    ),
  },
  {
    id: "consent",
    title: "Consent (and Consent Mode v2)",
    summary: "How consent affects what is sent.",
    body: (
      <Text as="p">
        With Consent mode on, events respect the Customer Privacy API. With Consent Mode v2 enabled,
        instead of dropping events when a visitor declines, the app sends a privacy-safe, flagged hit so
        GA4 can model the missing conversions; Meta is skipped without marketing consent. Untick Consent
        Mode v2 for strict gating, where nothing fires until consent is granted. You can see exactly how
        each consent state changes the payload in the Event sandbox.
      </Text>
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
      <Text as="p">
        Every server-side send is logged with its outcome. The <Link to="/app/events">Live events</Link>{" "}
        page shows a <b>Delivery health (last 24h)</b> panel - green when a destination is receiving
        everything, red with a failure count when something is wrong (for example a bad Meta token). The
        Home page flags recent delivery failures too. This is the fastest way to catch a broken credential
        before it costs you data.
      </Text>
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
          <b>Google Ads:</b> no setup is needed here. The server-side GA4 purchase carries the right
          client_id, so it stitches to the on-page session that holds the gclid. Link your GA4 property to
          Google Ads and import the purchase conversion (no API or developer token).
        </Text>
        <Text as="p">
          <b>GTM:</b> a web container (GTM-XXXX) cannot load in the pixel sandbox, so GTM events are
          delivered to your server-side GTM container. Add its URL on the Settings page.
        </Text>
      </BlockStack>
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
