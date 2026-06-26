import { useEffect, useMemo, useState } from "react";
import { useLoaderData, useRevalidator, Form } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Select,
  Collapsible,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { eventLabel } from "../lib/event-labels";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [events, logs] = await Promise.all([
    prisma.recentEvent.findMany({
      where: { shopDomain: session.shop },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.deliveryLog.findMany({
      where: { shopDomain: session.shop, createdAt: { gte: since } },
      select: { destination: true, ok: true },
    }),
  ]);
  const byDest = {};
  for (const l of logs) {
    const h = (byDest[l.destination] ||= { ok: 0, fail: 0 });
    if (l.ok) h.ok += 1;
    else h.fail += 1;
  }
  const health = Object.entries(byDest)
    .map(([destination, h]) => ({ destination, ...h, total: h.ok + h.fail }))
    .sort((a, b) => a.destination.localeCompare(b.destination));
  return {
    events: events.map((e) => ({
      id: e.id,
      name: e.name,
      payload: e.payload,
      createdAt: e.createdAt.toISOString(),
    })),
    health,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "clear") {
    await prisma.recentEvent.deleteMany({ where: { shopDomain: session.shop } });
  }
  return { ok: true };
};

function prettyPayload(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const DEST_LABELS = {
  ga4: "GA4",
  meta: "Meta CAPI",
  gtm: "Server-side GTM",
  ga4_subscription: "GA4 subscription",
  ga4_refund: "GA4 refund",
};

export default function Events() {
  const { events, health } = useLoaderData();
  const revalidator = useRevalidator();
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState(null);

  // Poll every 5s so events stream in live.
  useEffect(() => {
    const t = setInterval(() => revalidator.revalidate(), 5000);
    return () => clearInterval(t);
  }, [revalidator]);

  const names = useMemo(() => Array.from(new Set(events.map((e) => e.name))), [events]);
  const filtered = filter === "all" ? events : events.filter((e) => e.name === filter);

  return (
    <Page
      title="Live events"
      subtitle="Server-side events as the app receives them. Auto-refreshes every 5 seconds."
      primaryAction={{ content: "Refresh", onAction: () => revalidator.revalidate() }}
      secondaryActions={
        events.length
          ? [{ content: "Clear", destructive: true, onAction: () => document.getElementById("clear-events")?.requestSubmit() }]
          : []
      }
    >
      <Form method="post" id="clear-events" style={{ display: "none" }}>
        <input type="hidden" name="intent" value="clear" />
      </Form>

      <BlockStack gap="300">
        {health.length > 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Delivery health (last 24h)</Text>
              <InlineStack gap="300" wrap>
                {health.map((h) => (
                  <InlineStack key={h.destination} gap="150" blockAlign="center">
                    <Badge tone={h.fail === 0 ? "success" : "critical"}>
                      {DEST_LABELS[h.destination] || h.destination}
                    </Badge>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {h.ok}/{h.total} delivered{h.fail > 0 ? ` · ${h.fail} failed` : ""}
                    </Text>
                  </InlineStack>
                ))}
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {events.length > 0 && (
          <Card>
            <InlineStack gap="300" blockAlign="center">
              <Box minWidth="260px">
                <Select
                  label="Filter by event"
                  labelInline
                  options={[{ label: "All events", value: "all" }, ...names.map((n) => ({ label: eventLabel(n), value: n }))]}
                  value={filter}
                  onChange={setFilter}
                />
              </Box>
              <Text as="span" tone="subdued" variant="bodySm">
                {filtered.length} of {events.length} shown
              </Text>
            </InlineStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="200">
            {filtered.length === 0 ? (
              <Text as="p" tone="subdued">
                No events yet. These appear once the app proxy is live (a deployed host) and the pixel
                is firing with consent. They don&apos;t flow over localhost - use a tunnel or deploy to
                see them, or preview payloads now in the Event sandbox.
              </Text>
            ) : (
              filtered.map((e) => {
                const open = expanded === e.id;
                return (
                  <Box key={e.id} borderColor="border" borderBlockEndWidth="025" paddingBlockEnd="200">
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : e.id)}
                      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}
                      aria-expanded={open}
                    >
                      <InlineStack align="space-between" blockAlign="center" wrap={false}>
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone="info">{eventLabel(e.name)}</Badge>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {open ? "Hide payload" : "Show payload"}
                          </Text>
                        </InlineStack>
                        <Text as="span" tone="subdued" variant="bodySm">
                          {new Date(e.createdAt).toLocaleTimeString()}
                        </Text>
                      </InlineStack>
                    </button>
                    <Collapsible id={`payload-${e.id}`} open={open}>
                      <Box background="bg-surface-secondary" borderRadius="200" padding="300" overflowX="scroll">
                        <pre style={{ margin: 0, fontFamily: "var(--p-font-family-mono)", fontSize: "12px", whiteSpace: "pre" }}>
                          {prettyPayload(e.payload)}
                        </pre>
                      </Box>
                    </Collapsible>
                  </Box>
                );
              })
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
