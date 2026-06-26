import { Link } from "@remix-run/react";
import { Page, Card, BlockStack, Text, List, Banner, Box } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { SectionHeading } from "../components/SectionHeading";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

function Section({ title, help, children }) {
  return (
    <Card>
      <BlockStack gap="300">
        <SectionHeading title={title} help={help} />
        {children}
      </BlockStack>
    </Card>
  );
}

export default function Help() {
  return (
    <Page
      title="Help"
      subtitle="What this app does, how it delivers events, and how to test before you trust the data."
    >
      <BlockStack gap="400">
        <Section
          title="What Pixel Kicks Tracking does"
          help="A free, server-side conversion + engagement tracker for any Shopify store."
        >
          <Text as="p">
            It captures storefront and checkout events and delivers them server-side to GA4
            (Measurement Protocol), Meta (Conversions API) and a server-side GTM container. On top of
            the standard events it adds subscription conversion tracking from paid orders and SEO
            engagement signals (scroll depth and engaged-content views).
          </Text>
          <Text as="p" tone="subdued">
            Because delivery is server-side, events keep flowing past ad blockers, Safari ITP and the
            checkout sandbox that breaks theme-based tracking.
          </Text>
        </Section>

        <Section
          title="How it works"
          help="One first-party beacon to the app, then server-side fan-out to each destination."
        >
          <List>
            <List.Item>
              The <b>web pixel</b> (Shopify Web Pixels API) subscribes to standard customer events,
              including checkout and purchase, which theme scripts can no longer reach.
            </List.Item>
            <List.Item>
              The <b>SEO engagement app embed</b> runs on the storefront and captures scroll depth and
              engaged-content views, which are not Shopify customer events.
            </List.Item>
            <List.Item>
              Both send one first-party beacon to the app proxy, which forwards the event server-side
              to GA4 / Meta / server-side GTM using the credentials you store. In the strict pixel
              sandbox you cannot load gtag or fbq, so server-side is the delivery path.
            </List.Item>
            <List.Item>
              Subscription conversions come from the <b>orders/paid</b> webhook, not the pixel.
            </List.Item>
          </List>
        </Section>

        <Section
          title="Setup checklist"
          help="The order to switch things on."
        >
          <List type="number">
            <List.Item>
              On <Link to="/app/tracking">Tracking</Link>, enter your GA4, Meta and/or GTM IDs and tick
              which events each platform should receive.
            </List.Item>
            <List.Item>
              On <Link to="/app/settings">Settings</Link>, add the server-side credentials (GA4
              Measurement Protocol secret, Meta CAPI token, and a server-side GTM container URL if you
              use GTM).
            </List.Item>
            <List.Item>Turn on <b>Server-side</b> delivery on the Tracking page.</List.Item>
            <List.Item>
              For scroll and engaged-content events, enable the <b>Pixelify SEO engagement</b> app embed
              in Theme editor, App embeds, then tick those events on the Tracking page.
            </List.Item>
            <List.Item>
              The app proxy and webhooks need a deployed (public) host. They do not work on localhost,
              so deploy or use a tunnel to test live delivery.
            </List.Item>
          </List>
        </Section>

        <Section
          title="How to test"
          help="From safe preview to live verification."
        >
          <List>
            <List.Item>
              <b><Link to="/app/sandbox">Event sandbox</Link></b>: preview the exact GTM dataLayer,
              GA4 and Meta payloads for any event (or several together), with different consent states.
              Nothing is sent, so it is safe to experiment and to build GTM tags against.
            </List.Item>
            <List.Item>
              <b>Debug mode</b> (Tracking page): logs every event to the storefront browser console.
              Open the storefront, then DevTools, Console, and look for “[pixelify-tracking]”. This
              confirms events fire and respect consent without configuring any destination.
            </List.Item>
            <List.Item>
              <b><Link to="/app/events">Live events</Link></b>: once deployed, server-side events stream
              here as they arrive (it does not work over localhost).
            </List.Item>
            <List.Item>
              <b>GA4 DebugView</b> and <b>Meta Test Events</b>: the source of truth for confirming events
              actually land in each platform with the right parameters.
            </List.Item>
          </List>
        </Section>

        <Section
          title="Consent (and Consent Mode v2)"
          help="How consent affects what is sent."
        >
          <Text as="p">
            With Consent mode on, events respect the Customer Privacy API. With Consent Mode v2 enabled,
            instead of dropping events when a visitor declines, the app sends a privacy-safe, flagged hit
            so GA4 can model the missing conversions. Meta is skipped without marketing consent. Untick
            Consent Mode v2 for strict gating, where nothing fires until consent is granted. You can see
            exactly how each consent state changes the payload in the Event sandbox.
          </Text>
        </Section>

        <Section
          title="Subscription conversion tracking"
          help="Recurring revenue that GA4 normally never sees."
        >
          <Text as="p">
            When enabled, a paid order fires a server-side subscription_purchase event to GA4. It uses a
            distinct event name so it never collides with the native purchase, and recurring orders
            inherit the first order&apos;s client_id and source/medium/campaign, so they keep their
            original attribution instead of looking like fresh direct traffic.
          </Text>
        </Section>

        <Section
          title="Avoiding double-counting with the Google & YouTube app"
          help="How this app coexists with native GA4 / Google Ads tracking."
        >
          <BlockStack gap="200">
            <Text as="p">
              If the store runs the native Google &amp; YouTube app, it already sends the standard GA4
              ecommerce events, including <b>purchase</b>. Server-side events here de-dup safely: GA4
              collapses purchases on matching <b>transaction_id</b> and Meta de-dups on <b>event_id</b>.
              For other events, prefer to track here only what the native app does not already send.
            </Text>
            <Text as="p">
              <b>Google Ads:</b> no setup is needed here. The server-side GA4 purchase carries the right
              client_id, so it stitches to the on-page session that holds the gclid. Link your GA4
              property to Google Ads and import the purchase conversion (no API or developer token).
            </Text>
            <Text as="p">
              <b>GTM:</b> a web container (GTM-XXXX) cannot load in the pixel sandbox, so GTM events are
              delivered to your server-side GTM container. Add its URL on the Settings page.
            </Text>
          </BlockStack>
        </Section>

        <Banner tone="info">
          Still stuck? The Event sandbox shows precisely what the app would send, and Debug mode confirms
          what fires on the storefront. Between them you can diagnose almost any tracking question without
          guessing.
        </Banner>
        <Box paddingBlockEnd="400" />
      </BlockStack>
    </Page>
  );
}
