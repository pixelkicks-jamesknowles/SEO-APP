import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  InlineGrid,
  Badge,
  Button,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const [seo, tracking, openRedirects] = await Promise.all([
    prisma.seoSettings.findUnique({ where: { shopDomain } }),
    prisma.trackingSettings.findUnique({ where: { shopDomain } }),
    prisma.redirect404Log.count({ where: { shopDomain, resolved: false } }),
  ]);
  const trackingPlatforms = tracking
    ? ["gtmId", "ga4Id", "metaPixelId", "tiktokPixelId"].filter((k) => tracking[k])
        .length
    : 0;
  return { hasSeo: !!seo, trackingPlatforms, openRedirects };
};

export default function Index() {
  const { hasSeo, trackingPlatforms, openRedirects } = useLoaderData();
  return (
    <Page title="Pixelify SEO + Tracking">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Setup checklist
              </Text>
              {[
                { state: hasSeo ? "done" : "todo", label: "Save your SEO meta templates" },
                {
                  state: trackingPlatforms > 0 ? "done" : "todo",
                  label: "Add at least one tracking platform",
                },
                {
                  state: "manual",
                  label:
                    "Enable the SEO Schema app embed in Online Store → Themes → Customize → App embeds",
                },
              ].map((step) => (
                <InlineStack key={step.label} gap="200" blockAlign="center" wrap={false}>
                  <Badge tone={step.state === "done" ? "success" : "attention"}>
                    {step.state === "done" ? "Done" : step.state === "manual" ? "Manual" : "To do"}
                  </Badge>
                  <Text as="span" variant="bodyMd">
                    {step.label}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  SEO core
                </Text>
                <Text as="p" tone="subdued">
                  Deterministic meta templates, validated JSON-LD with dedup, audit + CWV,
                  redirects and robots.
                </Text>
                <Badge tone={hasSeo ? "success" : "attention"}>
                  {hasSeo ? "Configured" : "Not configured"}
                </Badge>
                <Button url="/app/seo">Open SEO</Button>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Tracking
                </Text>
                <Text as="p" tone="subdued">
                  GTM / GA4 / Meta / TikTok with an event matrix, consent-gated, via the Web
                  Pixels API.
                </Text>
                <Badge tone={trackingPlatforms ? "success" : "attention"}>
                  {trackingPlatforms
                    ? `${trackingPlatforms} platform(s) on`
                    : "No platforms on"}
                </Badge>
                <Button url="/app/tracking">Open Tracking</Button>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Open 404s needing a redirect
              </Text>
              <Text as="p" variant="headingLg">
                {openRedirects}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
