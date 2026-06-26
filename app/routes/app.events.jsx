import { useEffect } from "react";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Badge } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const events = await prisma.recentEvent.findMany({
    where: { shopDomain: session.shop },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return {
    events: events.map((e) => ({
      id: e.id,
      name: e.name,
      platform: e.platform,
      createdAt: e.createdAt.toISOString(),
    })),
  };
};

export default function Events() {
  const { events } = useLoaderData();
  const revalidator = useRevalidator();

  // Poll every 5s so events stream in live.
  useEffect(() => {
    const t = setInterval(() => revalidator.revalidate(), 5000);
    return () => clearInterval(t);
  }, [revalidator]);

  return (
    <Page
      title="Live events"
      subtitle="Server-side events from the Web Pixel - auto-refreshes every 5s"
      primaryAction={{ content: "Refresh", onAction: () => revalidator.revalidate() }}
    >
      <Card>
        <BlockStack gap="200">
          {events.length === 0 ? (
            <Text as="p" tone="subdued">
              No events yet. These appear once the app proxy is live (deployed host) and the pixel
              is firing with consent - they don’t flow over localhost.
            </Text>
          ) : (
            events.map((e) => (
              <InlineStack key={e.id} align="space-between" blockAlign="center" wrap={false}>
                <InlineStack gap="200" blockAlign="center">
                  <Badge>{e.platform || "-"}</Badge>
                  <Text as="span" variant="bodyMd">
                    {e.name}
                  </Text>
                </InlineStack>
                <Text as="span" tone="subdued" variant="bodySm">
                  {new Date(e.createdAt).toLocaleTimeString()}
                </Text>
              </InlineStack>
            ))
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}
