import { useLoaderData, useActionData, useNavigation, Form } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Banner, Button, Icon, Badge, Divider, TextField, Box } from "@shopify/polaris";
import { CheckCircleIcon, AlertCircleIcon } from "@shopify/polaris-icons";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { readServerSideKeys } from "../lib/secrets.server";
import { buildChecklist, checklistStatus } from "../lib/wizard";
import { validateGa4Event, validateMetaEvent, sendGa4Event } from "../lib/server-side.server";
import { logActivity } from "../lib/activity.server";
import { SectionHeading } from "../components/SectionHeading";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain: session.shop } });
  const keys = readServerSideKeys(tracking);
  const items = buildChecklist(tracking, keys);
  return { items, status: checklistStatus(items), hasGa4: Boolean(tracking?.ga4Id), hasMeta: Boolean(tracking?.metaPixelId) };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const testEventCode = (form.get("metaTestCode") || "").trim() || undefined;
  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain } });
  if (!tracking?.serverSide) return { error: "Turn on Server-side delivery on the Tracking page first." };

  const results = [];
  // GA4: validate the payload (the live endpoint always 204s), then send a distinctly-named test hit.
  if (tracking.ga4Id) {
    const event = { name: "pixelify_diagnostic", params: { debug_mode: 1, source: "pixelify-wizard" }, clientId: "test.0" };
    const v = await validateGa4Event(tracking, event);
    if (!v.ok) results.push({ dest: "GA4", ok: false, detail: v.messages.join("; ") });
    else {
      const r = await sendGa4Event(tracking, event);
      results.push({ dest: "GA4", ok: !!r.sent, detail: r.sent ? "sent — check GA4 DebugView" : r.detail || "send failed" });
    }
  }
  // Meta: send a PageView tagged with the test_event_code so it shows under Test Events.
  if (tracking.metaPixelId) {
    const m = await validateMetaEvent(tracking, { testEventCode });
    results.push({ dest: "Meta", ok: m.ok, detail: m.ok ? "sent — check Meta Test Events" : m.messages.join("; ") });
  }
  if (!results.length) return { error: "No destination with a secret to test. Add a GA4 secret or Meta token on Settings." };
  await logActivity(shopDomain, `Ran setup diagnostics: ${results.map((r) => `${r.dest} ${r.ok ? "ok" : "fail"}`).join(", ")}`);
  return { results };
};

function Check({ item }) {
  return (
    <InlineStack gap="200" blockAlign="start" wrap={false} align="start">
      <Box minWidth="20px">
        <Icon source={item.ok ? CheckCircleIcon : AlertCircleIcon} tone={item.ok ? "success" : "critical"} />
      </Box>
      {/* width:100% makes the text column fill the row so the icon stays pinned left. */}
      <Box width="100%">
        <BlockStack gap="050">
          <Text as="span" variant="bodyMd">{item.label}</Text>
          {!item.ok && (
            <Text as="span" variant="bodySm" tone="subdued">
              {item.hint} <a href={item.url}>Fix</a>
            </Text>
          )}
        </BlockStack>
      </Box>
    </InlineStack>
  );
}

export default function Wizard() {
  const { items, status, hasMeta } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const running = nav.state !== "idle";
  const [metaTestCode, setMetaTestCode] = useState("");

  return (
    <Page title="Setup check" subtitle="Confirm your tracking is wired up correctly, then fire a live test event end-to-end.">
      <BlockStack gap="400">
        {status === "ready" ? (
          <Banner tone="success" title="Everything's configured">
            Your destinations, credentials and Web Pixel are all set. Run a live test below to confirm events land.
          </Banner>
        ) : status === "empty" ? (
          <Banner tone="warning" title="Not set up yet">
            Start on the Tracking page: add a destination, turn on Server-side delivery, and save to install the pixel.
          </Banner>
        ) : (
          <Banner tone="warning" title="Almost there">
            A few things still need attention below before tracking is fully live.
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <SectionHeading title="Configuration checklist" description="Each item is required for server-side events to be delivered." />
            <Divider />
            {items.map((item) => (
              <Check key={item.key} item={item} />
            ))}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading title="Live test" description="Sends a distinctly-named diagnostic event to each configured destination. It verifies your credentials + the server-side pipeline — it does not test storefront checkout capture (that needs a real checkout on a deployed store)." />
            <Divider />
            <Form method="post">
              <BlockStack gap="300">
                {hasMeta && (
                  <TextField
                    label="Meta test event code (optional)"
                    name="metaTestCode"
                    autoComplete="off"
                    value={metaTestCode}
                    onChange={setMetaTestCode}
                    helpText="From Meta Events Manager → Test Events. Tags the test so it shows there instead of live reporting."
                  />
                )}
                <InlineStack>
                  <Button submit variant="primary" loading={running}>Run diagnostics</Button>
                </InlineStack>
              </BlockStack>
            </Form>

            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}
            {actionData?.results && (
              <BlockStack gap="200">
                {actionData.results.map((r) => (
                  <InlineStack key={r.dest} gap="200" blockAlign="center">
                    <Badge tone={r.ok ? "success" : "critical"}>{r.dest}</Badge>
                    <Text as="span" variant="bodySm" tone={r.ok ? "subdued" : "critical"}>{r.detail}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
