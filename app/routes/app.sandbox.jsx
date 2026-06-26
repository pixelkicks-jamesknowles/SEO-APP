import { useState } from "react";
import { useActionData, Form, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Checkbox,
  RadioButton,
  Button,
  Banner,
  Box,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { SectionHeading } from "../components/SectionHeading";
import { EVENT_SAMPLES, SANDBOX_EVENTS, SUBSCRIPTION_SAMPLE } from "../lib/event-samples";
import { ga4EventFor, metaEventFor, dataLayerFor, dataLayerFromGa4, ga4Consent } from "../lib/server-side.server";
import { buildSubscriptionEvent, syntheticClientId } from "../lib/subscription";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { events: SANDBOX_EVENTS };
};

const CONSENT_MAP = {
  full: { analytics: true, marketing: true },
  analytics: { analytics: true, marketing: false },
  none: { analytics: false, marketing: false },
  off: undefined,
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const consentChoice = form.get("consent") || "full";
  const consent = CONSENT_MAP[consentChoice];

  // Normalize selection into { subscription } markers or { name, ev } sample/custom events.
  let items;
  const advanced = (form.get("advanced") || "").trim();
  if (advanced) {
    try {
      const parsed = JSON.parse(advanced);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      items = arr.map((ev) => ({ name: ev.name, ev }));
    } catch (e) {
      return { error: `Couldn't parse the pasted JSON: ${e.message}` };
    }
  } else {
    const picked = form.getAll("evt");
    if (!picked.length) return { error: "Pick at least one event (or paste your own JSON)." };
    items = picked
      .map((name) =>
        name === "subscription_purchase" ? { subscription: true } : { name, ev: EVENT_SAMPLES[name] },
      )
      .filter((it) => it.subscription || it.ev);
  }

  const results = items.map((it) => {
    // subscription_purchase is built from an order by buildSubscriptionEvent + sent server-side to GA4.
    if (it.subscription) {
      const { order, attribution } = SUBSCRIPTION_SAMPLE;
      const clientId = syntheticClientId(order.id);
      const se = buildSubscriptionEvent(order, { eventName: "subscription_purchase", monthDays: 28, clientId, attribution });
      const ga4Event = { name: se.name, params: se.params };
      return {
        name: "subscription_purchase",
        note: "Server-side event from the orders/paid webhook (not the Web Pixel). Recurring orders inherit the first order's client_id + source/medium/campaign, shown here.",
        dataLayer: dataLayerFromGa4(ga4Event),
        ga4Body: { client_id: se.clientId, events: [ga4Event] },
        meta: { skipped: "Subscription conversions are GA4 server-side only. Consent is gated upstream by the order's marketing-consent flag." },
      };
    }

    // Apply the chosen consent state; leave undefined when consent mode is "off".
    const ev = { ...it.ev };
    if (consent === undefined) delete ev.consent;
    else ev.consent = consent;
    const name = ev.name;

    const ga4Event = ga4EventFor(name, ev);
    const ga4Body = { client_id: ev.clientId || "<synthetic>", events: [ga4Event] };
    const consentBlock = ga4Consent(ev.consent);
    if (consentBlock) ga4Body.consent = consentBlock;

    const marketingOk = !ev.consent || ev.consent.marketing;
    const meta = marketingOk
      ? { body: { data: [metaEventFor(name, ev)] } }
      : { skipped: "No marketing consent - Meta CAPI is not sent (Consent Mode v2)." };

    return { name, dataLayer: dataLayerFor(name, ev), ga4Body, meta };
  });

  return { results, consentChoice };
};

function Code({ value }) {
  return (
    <Box
      background="bg-surface-secondary"
      borderRadius="200"
      padding="300"
      overflowX="scroll"
    >
      <pre style={{ margin: 0, fontFamily: "var(--p-font-family-mono)", fontSize: "12px", whiteSpace: "pre", lineHeight: 1.5 }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </Box>
  );
}

export default function Sandbox() {
  const events = SANDBOX_EVENTS;
  const actionData = useActionData();
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  const [selected, setSelected] = useState({ checkout_completed: true });
  const [consent, setConsent] = useState("full");
  const [advanced, setAdvanced] = useState("");
  const toggle = (name) => setSelected((s) => ({ ...s, [name]: !s[name] }));

  const consentOptions = [
    ["full", "Full consent (analytics + marketing)"],
    ["analytics", "Analytics only (marketing denied)"],
    ["none", "No consent"],
    ["off", "Consent mode off"],
  ];

  return (
    <Page
      title="Event sandbox"
      subtitle="Preview the exact GTM / GA4 / Meta output for each event, using the real production builders. Nothing is sent - this is preview only."
    >
      <BlockStack gap="400">
        <Card>
          <Form method="post">
            <BlockStack gap="400">
              <SectionHeading
                title="Choose events"
                help="Tick one or more events to see how they would be transformed and delivered. Combine several to preview a full journey."
              />
              <InlineStack gap="300" wrap>
                {events.map((name) => (
                  <span key={name}>
                    {selected[name] && <input type="hidden" name="evt" value={name} />}
                    <Checkbox label={name} checked={!!selected[name]} onChange={() => toggle(name)} />
                  </span>
                ))}
              </InlineStack>

              <Divider />
              <SectionHeading
                title="Consent state"
                help="See how Consent Mode v2 changes the output: GA4 events carry consent flags and Meta is skipped without marketing consent."
              />
              <input type="hidden" name="consent" value={consent} />
              <InlineStack gap="400" wrap>
                {consentOptions.map(([value, label]) => (
                  <RadioButton
                    key={value}
                    label={label}
                    checked={consent === value}
                    id={`consent-${value}`}
                    name="consent-ui"
                    onChange={() => setConsent(value)}
                  />
                ))}
              </InlineStack>

              <Divider />
              <details>
                <summary style={{ cursor: "pointer" }}>
                  <Text as="span" variant="bodyMd">Advanced: paste your own event payload(s)</Text>
                </summary>
                <Box paddingBlockStart="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    A JSON array of event objects (each needs a <code>name</code> and a <code>data</code>
                    matching the Shopify Web Pixels shape). When filled, this overrides the ticked events.
                  </Text>
                  <Box paddingBlockStart="200">
                    <textarea
                      name="advanced"
                      value={advanced}
                      onChange={(e) => setAdvanced(e.target.value)}
                      rows={8}
                      placeholder={`[\n  { "name": "product_viewed", "data": { "productVariant": { "sku": "ABC", "price": { "amount": 9.99, "currencyCode": "GBP" } } } }\n]`}
                      style={{ width: "100%", fontFamily: "var(--p-font-family-mono)", fontSize: "12px", padding: "8px", boxSizing: "border-box" }}
                    />
                  </Box>
                </Box>
              </details>

              <InlineStack>
                <Button submit variant="primary" loading={busy}>Preview output</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Card>

        {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

        {actionData?.results?.map((r, i) => (
          <Card key={`${r.name}-${i}`}>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{r.name}</Text>
              {r.note && (
                <Banner tone="info">{r.note}</Banner>
              )}

              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">GTM dataLayer push</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  What you reference when building GTM triggers/variables.
                </Text>
                <Code value={r.dataLayer} />
              </BlockStack>

              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">GA4 Measurement Protocol / server-side GTM</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  The exact body POSTed to GA4 /mp/collect (and to your sGTM container&apos;s /g/collect).
                </Text>
                <Code value={r.ga4Body} />
              </BlockStack>

              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">Meta Conversions API</Text>
                {r.meta.skipped ? (
                  <Text as="p" tone="subdued">{r.meta.skipped}</Text>
                ) : (
                  <Code value={r.meta.body} />
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        ))}
      </BlockStack>
    </Page>
  );
}
