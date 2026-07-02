import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Layout, Card, Text, BlockStack, InlineStack, Badge, Button, List, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { readServerSideKeys } from "../lib/secrets.server";
import { computeHealth, dismissAlert } from "../lib/health.server";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("_action") === "dismissAlert") {
    await dismissAlert(session.shop, form.get("kind"));
  }
  return { ok: true };
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [tracking, recentEvents, deliveryFailures, health] = await Promise.all([
    prisma.trackingSettings.findUnique({ where: { shopDomain } }),
    prisma.recentEvent.count({ where: { shopDomain } }),
    prisma.deliveryLog.count({ where: { shopDomain, ok: false, createdAt: { gte: since } } }),
    computeHealth(shopDomain),
  ]);
  const keys = readServerSideKeys(tracking);
  const idKeys = ["gtmId", "ga4Id", "metaPixelId"];
  const platforms = tracking ? idKeys.filter((k) => tracking[k]).length : 0;
  const serverSide = tracking?.serverSide ?? false;

  // Config health: catch the "looks set up but sends nothing" traps.
  const warnings = [];
  if (platforms && !serverSide) {
    warnings.push("You've added platform IDs but Server-side delivery is off, so nothing is being sent. Turn it on in Tracking.");
  }
  if (serverSide && tracking?.ga4Id && !keys.ga4ApiSecret) {
    warnings.push("GA4 is set and Server-side is on, but there's no GA4 Measurement Protocol secret on Settings, so GA4 events can't be delivered.");
  }
  if (serverSide && tracking?.metaPixelId && !keys.metaCapiToken) {
    warnings.push("Meta Pixel is set and Server-side is on, but there's no Meta CAPI token on Settings, so Meta events can't be delivered.");
  }

  return {
    platforms,
    recentEvents,
    deliveryFailures,
    serverSide,
    subscriptionTracking: tracking?.subscriptionTracking ?? false,
    warnings,
    alerts: health.alerts,
  };
};

export default function Index() {
  const { platforms, recentEvents, deliveryFailures, serverSide, subscriptionTracking, warnings, alerts } = useLoaderData();
  const notConfigured = platforms === 0;
  const dismisser = useFetcher();

  return (
    <Page
      title="Pixel Kicks Tracking"
      subtitle="Free, server-side conversion & SEO tracking for any Shopify store."
    >
      <Layout>
        {alerts.map((a) => (
          <Layout.Section key={a.kind}>
            <Banner
              tone={a.severity === "critical" ? "critical" : "warning"}
              title={a.title}
              action={{ content: "View Accuracy", url: "/app/accuracy" }}
              onDismiss={() => dismisser.submit({ _action: "dismissAlert", kind: a.kind }, { method: "post" })}
            >
              <p>{a.body}</p>
            </Banner>
          </Layout.Section>
        ))}

        {notConfigured && (
          <Layout.Section>
            <Banner
              tone="info"
              title="You're not tracking anything yet"
              action={{ content: "Set up tracking", url: "/app/tracking" }}
              secondaryAction={{ content: "Read the guide", url: "/app/help" }}
            >
              <p>Add a GA4, Meta or GTM destination on the Tracking page, then turn on Server-side delivery.</p>
            </Banner>
          </Layout.Section>
        )}

        {warnings.map((w, i) => (
          <Layout.Section key={i}>
            <Banner tone="warning" title="Check your setup">
              <p>{w}</p>
            </Banner>
          </Layout.Section>
        ))}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Status</Text>
              <InlineStack gap="200">
                <Badge tone={platforms ? "success" : "attention"}>
                  {platforms ? `${platforms} destination${platforms > 1 ? "s" : ""} configured` : "No destinations"}
                </Badge>
                <Badge tone={serverSide ? "success" : "attention"}>
                  {serverSide ? "Delivery on" : "Delivery off"}
                </Badge>
                <Badge tone={subscriptionTracking ? "success" : undefined}>
                  {subscriptionTracking ? "Subscription tracking on" : "Subscription tracking off"}
                </Badge>
                {recentEvents > 0 && <Badge tone="info">{`${recentEvents} recent event${recentEvents > 1 ? "s" : ""}`}</Badge>}
                {deliveryFailures > 0 && <Badge tone="critical">{`${deliveryFailures} delivery failure${deliveryFailures > 1 ? "s" : ""} (24h)`}</Badge>}
              </InlineStack>
              <InlineStack gap="300">
                <Button url="/app/tracking" variant="primary">Open Tracking</Button>
                <Button url="/app/sandbox">Test in the sandbox</Button>
                <Button url="/app/events">Live events</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Get set up</Text>
              <List type="number">
                <List.Item>On <b>Tracking</b>, add a destination ID (GA4, GTM or Meta) and tick which events each should receive.</List.Item>
                <List.Item>On <b>Settings</b>, add the server-side credentials (GA4 Measurement Protocol secret, Meta CAPI token).</List.Item>
                <List.Item>Turn on <b>Server-side delivery</b>, and keep <b>Consent mode</b> on so events respect Customer Privacy consent.</List.Item>
                <List.Item>Preview everything in the <b>Event sandbox</b>, then verify live in GA4 DebugView and Meta Test Events.</List.Item>
              </List>
              <InlineStack>
                <Button url="/app/help" variant="plain">How testing works</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
