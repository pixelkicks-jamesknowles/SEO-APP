import { useState } from "react";
import { useLoaderData, useActionData, useNavigation, useFetcher, Form } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Banner, Button, Badge, Divider, List, Box, Checkbox, RadioButton } from "@shopify/polaris";
import { ClipboardIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { requirePro, hasProAccess, PRO_PLAN } from "../lib/billing.server";
import { DATA_LAYER_EVENTS } from "../lib/datalayer";
import { SectionHeading } from "../components/SectionHeading";
import { eventLabel } from "../lib/event-labels";
import { EVENT_SAMPLES, SANDBOX_EVENTS, SUBSCRIPTION_SAMPLE } from "../lib/event-samples";
import { ga4EventFor, metaEventFor, dataLayerFor, dataLayerFromGa4, ga4Consent } from "../lib/server-side.server";
import { buildSubscriptionEvent, syntheticClientId } from "../lib/subscription";

// "Developer tools" — the two advanced/technical tools merged onto one page:
//   1. GTM data layer (the dl_* storefront data layer toggle + GTM setup)
//   2. Event preview (formerly "Event sandbox"): see the exact payload the app would send, without sending.

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain: session.shop } });
  const pro = await hasProAccess(billing);
  return {
    enabled: Boolean(tracking?.dataLayerEnabled),
    pro,
    planName: PRO_PLAN,
    events: DATA_LAYER_EVENTS,
    sandboxEvents: SANDBOX_EVENTS,
  };
};

const CONSENT_MAP = {
  full: { analytics: true, marketing: true },
  analytics: { analytics: true, marketing: false },
  none: { analytics: false, marketing: false },
  off: undefined,
};

export const action = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  // --- Toggle the storefront data layer ---
  if (intent === "toggle") {
    const enable = form.get("enabled") === "on";
    // Pro gate: no-op while billing is unenforced (the app is free today); turning OFF is always allowed.
    if (enable) await requirePro(billing);
    await prisma.trackingSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, dataLayerEnabled: enable },
      update: { dataLayerEnabled: enable },
    });
    return { ok: true, enabled: enable };
  }

  // --- Event preview (nothing is sent) ---
  const consentChoice = form.get("consent") || "full";
  const consent = CONSENT_MAP[consentChoice];

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
      .map((name) => (name === "subscription_purchase" ? { subscription: true } : { name, ev: EVENT_SAMPLES[name] }))
      .filter((it) => it.subscription || it.ev);
  }

  const results = items.map((it) => {
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
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value, null, 2);
  const copy = () => {
    try {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <Box background="bg-surface-secondary" borderRadius="200" padding="300">
      <BlockStack gap="100">
        <InlineStack align="end">
          <Button size="micro" variant="tertiary" icon={ClipboardIcon} onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </InlineStack>
        <Box overflowX="scroll">
          <pre style={{ margin: 0, fontFamily: "var(--p-font-family-mono)", fontSize: "12px", whiteSpace: "pre", lineHeight: 1.5 }}>{text}</pre>
        </Box>
      </BlockStack>
    </Box>
  );
}

export default function DeveloperTools() {
  const { enabled: savedEnabled, pro, planName, events, sandboxEvents } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();

  // Data-layer toggle uses a fetcher so it doesn't clear any preview output below (which lives on actionData).
  const toggle = useFetcher();
  const enabled = toggle.data?.ok ? toggle.data.enabled : savedEnabled;
  const toggleBusy = toggle.state !== "idle";

  // Event preview state.
  const [selected, setSelected] = useState({ checkout_completed: true });
  const [consent, setConsent] = useState("full");
  const [advanced, setAdvanced] = useState("");
  const toggleEvent = (name) => setSelected((s) => ({ ...s, [name]: !s[name] }));
  const previewBusy = nav.state === "submitting";
  const consentOptions = [
    ["full", "Full consent (analytics + marketing)"],
    ["analytics", "Analytics only (marketing denied)"],
    ["none", "No consent"],
    ["off", "Consent mode off"],
  ];

  return (
    <Page
      title="Developer tools"
      subtitle="Advanced tools for teams who run their own tags: a Google Tag Manager data layer, and a preview of the exact data the app sends. Skip this unless you're technical."
    >
      <BlockStack gap="400">
        {pro.enforced && !pro.active && (
          <Banner tone="info" title="This is a Pro feature">
            The GTM data layer is part of {planName}. Turning it on will prompt you to start the subscription.
          </Banner>
        )}
        {toggle.data?.ok && <Banner tone="success">Data layer {toggle.data.enabled ? "enabled" : "disabled"}.</Banner>}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <SectionHeading
                title="GTM data layer"
                description="When on, the theme app embed emits the full browse funnel to window.dataLayer on your storefront."
              />
              <Badge tone={enabled ? "success" : undefined}>{enabled ? "On" : "Off"}</Badge>
            </InlineStack>
            <Divider />
            <Text as="p" variant="bodyMd">
              Your GTM <b>web</b> container gets {events.length - 1} browse-funnel events, each fired twice — once in the
              GA4-standard shape (<code>view_item</code>, <code>add_to_cart</code>…) and once as its Elevar-compatible
              mirror (<code>dl_view_item</code>…) — so it works with GTM&rsquo;s built-in GA4 tags and with prebuilt
              Elevar containers alike.
            </Text>
            <List type="bullet">
              {events.filter((e) => e !== "user_data").map((e) => (
                <List.Item key={e}><code>{e}</code> / <code>dl_{e}</code></List.Item>
              ))}
              <List.Item><code>user_data</code> / <code>dl_user_data</code> — logged-in customer properties</List.Item>
            </List>
            <Banner tone="warning">
              <b>Purchase is delivered server-side, not in the page data layer.</b> Shopify&rsquo;s checkout is no longer
              themeable, so no app can push a <code>purchase</code> event to your web container. Pixelify sends the
              purchase conversion straight to GA4 / Meta server-side (deduped &amp; reconciled) — point your GA4
              config to that, or run a server-side GTM container for it.
            </Banner>
            <toggle.Form method="post">
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="enabled" value={enabled ? "off" : "on"} />
              <Button submit variant="primary" tone={enabled ? "critical" : undefined} loading={toggleBusy}>
                {enabled ? "Turn off data layer" : "Turn on data layer"}
              </Button>
            </toggle.Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading title="Set it up in Google Tag Manager" description="One-time wiring in your own GTM web container." />
            <Divider />
            <List type="number">
              <List.Item>Enable the <b>Pixelify SEO engagement</b> app embed (Theme editor → App embeds) — it hosts the data layer script.</List.Item>
              <List.Item>In GTM, confirm your GA4 Configuration tag is installed on the storefront (or add one).</List.Item>
              <List.Item>Create GA4 Event tags triggered on Custom Events <code>view_item</code>, <code>add_to_cart</code>, <code>begin_checkout</code>, etc., reading the <code>ecommerce</code> object — or import a prebuilt GA4 container that listens on the <code>dl_*</code> events.</List.Item>
              <List.Item>Use <b>Google Tag Assistant</b> (or GTM Preview) plus the browser console (<code>window.dataLayer</code>) to confirm events fire as you browse, add to cart, and hit checkout.</List.Item>
            </List>
            <Box background="bg-surface-secondary" padding="300" borderRadius="200">
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">
                  Events are consent-gated through the storefront&rsquo;s Customer Privacy API and only fire once the
                  toggle above is on — the storefront reads the live on/off state from the app, so it can&rsquo;t be
                  enabled from the theme editor alone.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  <b>Important for testing:</b> this data layer is the one place your on-page GTM / Tag Assistant
                  can see. The rest of the app delivers <b>server-side</b> (GA4 Measurement Protocol), which Tag
                  Assistant and GTM Preview can&rsquo;t see at all — so if you&rsquo;re debugging those, use{" "}
                  <b>Live events</b> and GA4 Realtime instead of Tag Assistant.
                </Text>
              </BlockStack>
            </Box>
          </BlockStack>
        </Card>

        {/* Event preview (was "Event sandbox") — safe preview of the exact payloads, nothing sent. */}
        <Card>
          <Form method="post">
            <input type="hidden" name="intent" value="preview" />
            <BlockStack gap="400">
              <SectionHeading
                title="Event preview"
                description="See the exact data the app would send for each event — a safe preview for checking your setup. Nothing is actually sent. Tick one or more events (combine them to preview a full journey)."
              />
              <InlineStack gap="200">
                <Button variant="plain" onClick={() => setSelected(Object.fromEntries(sandboxEvents.map((n) => [n, true])))}>Select all</Button>
                <Button variant="plain" onClick={() => setSelected({})}>Clear</Button>
              </InlineStack>
              <InlineStack gap="300" wrap>
                {sandboxEvents.map((name) => (
                  <span key={name}>
                    {selected[name] && <input type="hidden" name="evt" value={name} />}
                    <Checkbox label={eventLabel(name)} checked={!!selected[name]} onChange={() => toggleEvent(name)} />
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
                  <RadioButton key={value} label={label} checked={consent === value} id={`consent-${value}`} name="consent-ui" onChange={() => setConsent(value)} />
                ))}
              </InlineStack>

              <Divider />
              <details>
                <summary style={{ cursor: "pointer" }}>
                  <Text as="span" variant="bodyMd">Advanced: paste your own event payload(s)</Text>
                </summary>
                <Box paddingBlockStart="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    A JSON array of event objects (each needs a <code>name</code> and a <code>data</code> matching the
                    Shopify Web Pixels shape). When filled, this overrides the ticked events.
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
                <Button submit variant="primary" loading={previewBusy}>Preview output</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Card>

        {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

        {actionData?.results?.map((r, i) => (
          <Card key={`${r.name}-${i}`}>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{eventLabel(r.name)}</Text>
              {r.note && <Banner tone="info">{r.note}</Banner>}
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">GTM dataLayer push</Text>
                <Text as="p" tone="subdued" variant="bodySm">What you reference when building GTM triggers/variables.</Text>
                <Code value={r.dataLayer} />
              </BlockStack>
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">GA4 Measurement Protocol / server-side GTM</Text>
                <Text as="p" tone="subdued" variant="bodySm">The exact body POSTed to GA4 /mp/collect (and to your sGTM container&apos;s /g/collect).</Text>
                <Code value={r.ga4Body} />
              </BlockStack>
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">Meta Conversions API</Text>
                {r.meta.skipped ? <Text as="p" tone="subdued">{r.meta.skipped}</Text> : <Code value={r.meta.body} />}
              </BlockStack>
            </BlockStack>
          </Card>
        ))}
      </BlockStack>
    </Page>
  );
}
