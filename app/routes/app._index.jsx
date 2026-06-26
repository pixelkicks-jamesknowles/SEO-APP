import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, Text, BlockStack, InlineStack, Badge, Button, List } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const [tracking, recentEvents] = await Promise.all([
    prisma.trackingSettings.findUnique({ where: { shopDomain } }),
    prisma.recentEvent.count({ where: { shopDomain } }),
  ]);
  const platforms = tracking
    ? ["gtmId", "ga4Id", "metaPixelId"].filter((k) => tracking[k]).length
    : 0;
  return {
    platforms,
    recentEvents,
    serverSide: tracking?.serverSide ?? false,
    subscriptionTracking: tracking?.subscriptionTracking ?? false,
  };
};

export default function Index() {
  const { platforms, recentEvents, serverSide, subscriptionTracking } = useLoaderData();
  return (
    <Page title="Pixel Kicks Tracking" subtitle="Client-side + server-side conversion tracking for any Shopify store — free.">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Status</Text>
              <InlineStack gap="300">
                <Badge tone={platforms ? "success" : "attention"}>{platforms ? `${platforms} platform(s) on` : "No platforms on"}</Badge>
                <Badge tone={serverSide ? "success" : undefined}>{serverSide ? "Server-side on" : "Server-side off"}</Badge>
                <Badge tone={subscriptionTracking ? "success" : undefined}>{subscriptionTracking ? "Subscription tracking on" : "Subscription tracking off"}</Badge>
                <Badge>{`${recentEvents} recent event(s)`}</Badge>
              </InlineStack>
              <InlineStack gap="300">
                <Button url="/app/tracking" variant="primary">Open Tracking</Button>
                <Button url="/app/events">Live events</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Setup</Text>
              <List type="number">
                <List.Item>On <b>Tracking</b>, add a platform ID (GA4 / GTM / Meta / TikTok) and pick which events to send.</List.Item>
                <List.Item>Keep <b>Consent mode</b> on so tags fire only with Customer Privacy consent.</List.Item>
                <List.Item>For server-side / subscription events: add the GA4 Measurement Protocol secret on <b>Settings</b>, then enable Server-side + Subscription on Tracking.</List.Item>
                <List.Item>Enable the <b>tracking pixel</b> (web pixel extension) — added automatically on install.</List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
