import { useLoaderData } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Button, Badge, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getAccessToken, querySearchAnalytics } from "../lib/gsc.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const token = await getAccessToken(session.shop);
  let perf = null;
  if (token) perf = await querySearchAnalytics(token, `https://${session.shop}/`);
  return {
    configured: Boolean(process.env.GOOGLE_CLIENT_ID),
    connected: Boolean(token),
    shop: session.shop,
    perf,
  };
};

export default function Gsc() {
  const { configured, connected, shop, perf } = useLoaderData();

  return (
    <Page
      title="Google Search Console"
      subtitle="Pull impressions, clicks, and indexing status into the app."
    >
      <BlockStack gap="400">
        {!connected && (
          <Card>
            <BlockStack gap="400">
              <Text as="p">
                Connect your Google account to bring Search Console impressions, clicks, and
                indexing status into the app.
              </Text>
              <InlineStack>
                {/* target=_top breaks out of the embedded iframe for Google's consent screen. */}
                <a
                  href={`/auth/google?shop=${encodeURIComponent(shop)}`}
                  target="_top"
                  style={{ textDecoration: "none" }}
                >
                  <Button variant="primary" disabled={!configured}>
                    Connect Google Search Console
                  </Button>
                </a>
              </InlineStack>
              {!configured && (
                <Text as="p" tone="subdued" variant="bodySm">
                  Google sign-in isn’t enabled on this install yet — it’s a one-time app-level setup
                  (see DEPLOY.md). Once done, every store connects with one click.
                </Text>
              )}
            </BlockStack>
          </Card>
        )}

        {connected && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Top queries (last 28 days)
                </Text>
                <Badge tone="success">Connected</Badge>
              </InlineStack>
              {perf?.error && (
                <Banner tone="warning" title="Couldn’t load Search Console data">
                  {perf.error} — confirm the store domain has a verified Search Console property.
                </Banner>
              )}
              {perf?.rows?.length ? (
                <BlockStack gap="100">
                  {perf.rows.map((r, i) => (
                    <InlineStack key={i} align="space-between" blockAlign="center" wrap={false}>
                      <Text as="span" variant="bodyMd">
                        {r.query}
                      </Text>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {r.clicks} clicks · {r.impressions} impressions
                      </Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              ) : (
                !perf?.error && (
                  <Text as="p" tone="subdued">
                    No query data yet for this property.
                  </Text>
                )
              )}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
