import { useLoaderData } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fetchCrux } from "../lib/crux.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const s = await prisma.seoSettings.findUnique({ where: { shopDomain: session.shop } });
  if (!s?.cruxApiKey) return { needsKey: true };
  return { needsKey: false, data: await fetchCrux(s.cruxApiKey, `https://${session.shop}`) };
};

function row(label, value, unit, good, poor) {
  if (value == null) return { label, text: "No field data", tone: undefined };
  const n = Number(value);
  const tone = n <= good ? "success" : n <= poor ? "attention" : "critical";
  return { label, text: `${value}${unit}`, tone };
}

export default function Cwv() {
  const { needsKey, data } = useLoaderData();

  if (needsKey) {
    return (
      <Page title="Core Web Vitals">
        <Banner tone="info">
          Add a Google CrUX API key in Settings → Integrations to see real field data.
        </Banner>
      </Page>
    );
  }
  if (data?.error) {
    return (
      <Page title="Core Web Vitals">
        <Banner tone="warning" title="CrUX request failed">
          {data.error}
        </Banner>
      </Page>
    );
  }

  const rows = [
    row("LCP — largest contentful paint", data.lcp, " ms", 2500, 4000),
    row("INP — interaction to next paint", data.inp, " ms", 200, 500),
    row("CLS — cumulative layout shift", data.cls, "", 0.1, 0.25),
  ];

  return (
    <Page title="Core Web Vitals" subtitle="CrUX field data — mobile, 75th percentile">
      <Card>
        <BlockStack gap="300">
          {rows.map((r) => (
            <InlineStack key={r.label} align="space-between" blockAlign="center">
              <Text as="span" variant="bodyMd">
                {r.label}
              </Text>
              <Badge tone={r.tone}>{r.text}</Badge>
            </InlineStack>
          ))}
        </BlockStack>
      </Card>
    </Page>
  );
}
