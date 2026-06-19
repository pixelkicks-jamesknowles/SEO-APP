import { useLoaderData } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const items = await prisma.activityLog.findMany({
    where: { shopDomain: session.shop },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return { items: items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })) };
};

export default function Activity() {
  const { items } = useLoaderData();
  return (
    <Page title="Activity" subtitle="Recent saves, applies, and redirects.">

      <Card>
        <BlockStack gap="300">
          {items.length === 0 ? (
            <Text as="p" tone="subdued">
              No activity yet. Saves, applies, and redirects will appear here.
            </Text>
          ) : (
            items.map((i) => (
              <InlineStack key={i.id} align="space-between" blockAlign="center" wrap={false}>
                <BlockStack gap="050">
                  <Text as="span" variant="bodyMd">
                    {i.action}
                  </Text>
                  {i.detail && (
                    <Text as="span" tone="subdued" variant="bodySm">
                      {i.detail}
                    </Text>
                  )}
                </BlockStack>
                <Text as="span" tone="subdued" variant="bodySm">
                  {new Date(i.createdAt).toLocaleString()}
                </Text>
              </InlineStack>
            ))
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}
