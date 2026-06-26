import { useState, useRef, useEffect } from "react";
import { useLoaderData, useActionData, Form, useNavigation, useSubmit } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, TextField, Button, Banner, Badge } from "@shopify/polaris";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logActivity } from "../lib/activity.server";
import { sendGa4Event, validateGa4Event, ga4EventFor } from "../lib/server-side.server";
import { EVENT_SAMPLES } from "../lib/event-samples";
import { SectionHeading } from "../components/SectionHeading";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain: session.shop } });
  const keys = JSON.parse(tracking?.serverSideKeys || "{}");
  return {
    hasGa4Secret: Boolean(keys.ga4ApiSecret),
    hasCapiToken: Boolean(keys.metaCapiToken),
    gtmServerUrl: keys.gtmServerUrl || "",
    hasGa4Id: Boolean(tracking?.ga4Id),
    serverSideOn: Boolean(tracking?.serverSide),
    canTest: Boolean(tracking?.serverSide && tracking?.ga4Id && keys.ga4ApiSecret),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();

  // Send a live GA4 test event (verifies the secret end-to-end; appears in GA4 DebugView).
  const intent = form.get("intent");
  if (intent === "test" || intent === "test_purchase") {
    const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain } });
    if (!tracking?.serverSide) return { testError: "Turn on Server-side delivery on the Tracking page first." };
    if (!tracking?.ga4Id) return { testError: "Add a GA4 measurement ID on the Tracking page first." };

    let event;
    if (intent === "test_purchase") {
      // Purchase-shaped payload (the conversion that needs an app, since it fires in the checkout
      // sandbox). Distinctly named so it can't pollute real `purchase` revenue in GA4.
      const ga4 = ga4EventFor("checkout_completed", EVENT_SAMPLES.checkout_completed);
      event = {
        name: "pixelify_test_purchase",
        params: { ...ga4.params, transaction_id: "PIXELIFY-TEST", debug_mode: 1 },
        clientId: "test.0",
      };
    } else {
      event = { name: "pixelify_test", params: { debug_mode: 1, source: "pixelify-admin" }, clientId: "test.0" };
    }

    // Validate first (the real endpoint always returns 204, even for a bad secret/payload).
    const v = await validateGa4Event(tracking, event);
    if (!v.ok) {
      return { testError: `GA4 rejected the event: ${v.messages.join("; ")}. Check the measurement ID and secret belong to the same data stream.` };
    }
    const res = await sendGa4Event(tracking, event);
    await logActivity(shopDomain, `Sent GA4 ${intent === "test_purchase" ? "test purchase" : "test"} event`);
    if (!res.sent) return { testError: "Send failed after validating. Check the GA4 secret and that GA4 + Server-side are configured." };
    return {
      testOk:
        intent === "test_purchase"
          ? "Validated and sent a pixelify_test_purchase event (with items + value). Check GA4 → Realtime or DebugView. This tests the server→GA4 leg; the real pixel→server leg needs a checkout on a deployed store."
          : "Validated and sent a pixelify_test event. Look in GA4 → Reports → Realtime (a minute or two) or Admin → DebugView. The Admin → Events list can take ~24h, so check Realtime.",
    };
  }

  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain } });
  const keys = JSON.parse(tracking?.serverSideKeys || "{}");
  if (form.get("ga4ApiSecret")) keys.ga4ApiSecret = form.get("ga4ApiSecret");
  if (form.get("metaCapiToken")) keys.metaCapiToken = form.get("metaCapiToken");
  const gtmServerUrl = (form.get("gtmServerUrl") || "").trim();
  if (gtmServerUrl) keys.gtmServerUrl = gtmServerUrl;
  else delete keys.gtmServerUrl;
  const serverSideKeys = JSON.stringify(keys);
  await prisma.trackingSettings.upsert({
    where: { shopDomain },
    create: { shopDomain, serverSideKeys },
    update: { serverSideKeys },
  });
  await logActivity(shopDomain, "Saved server-side keys");
  return { ok: "Server-side keys saved." };
};

export default function Settings() {
  const { hasGa4Secret, hasCapiToken, gtmServerUrl: savedGtmUrl, hasGa4Id, serverSideOn, canTest } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const keysForm = useRef(null);

  const [ga4Secret, setGa4Secret] = useState("");
  const [capiToken, setCapiToken] = useState("");
  const [gtmUrl, setGtmUrl] = useState(savedGtmUrl);

  const busy = nav.state !== "idle";
  const dirty = ga4Secret !== "" || capiToken !== "" || gtmUrl !== savedGtmUrl;

  useEffect(() => {
    if (dirty) shopify.saveBar.show("settings-save");
    else shopify.saveBar.hide("settings-save");
  }, [dirty, shopify]);

  useEffect(() => {
    if (actionData?.ok && nav.state === "idle") {
      setGa4Secret("");
      setCapiToken("");
      shopify.saveBar.hide("settings-save");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData, nav.state]);

  const discard = () => {
    setGa4Secret("");
    setCapiToken("");
    setGtmUrl(savedGtmUrl);
  };
  const saveNow = () => submit(keysForm.current, { method: "post" });

  return (
    <Page
      title="Settings"
      subtitle="Server-side delivery credentials, and a live test."
      primaryAction={{ content: "Save", onAction: saveNow, loading: busy, disabled: !dirty }}
    >
      <SaveBar id="settings-save">
        <button variant="primary" onClick={saveNow}>Save</button>
        <button onClick={discard}>Discard</button>
      </SaveBar>
      <BlockStack gap="400">
        {actionData?.ok && <Banner tone="success">{actionData.ok}</Banner>}
        {actionData?.testOk && <Banner tone="success">{actionData.testOk}</Banner>}
        {actionData?.testError && <Banner tone="warning">{actionData.testError}</Banner>}

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Server-side credentials"
              description="Used by server-side delivery: the GA4 Measurement Protocol secret (also powers the subscription event), the Meta CAPI token, and a server-side GTM container URL."
            />
            <InlineStack gap="200">
              <Badge tone={hasGa4Secret ? "success" : undefined}>{hasGa4Secret ? "GA4 secret saved" : "No GA4 secret"}</Badge>
              <Badge tone={hasCapiToken ? "success" : undefined}>{hasCapiToken ? "Meta token saved" : "No Meta token"}</Badge>
              <Badge tone={savedGtmUrl ? "success" : undefined}>{savedGtmUrl ? "sGTM URL saved" : "No sGTM URL"}</Badge>
            </InlineStack>
            <Form method="post" ref={keysForm}>
              <BlockStack gap="200">
                <TextField
                  label="GA4 API secret"
                  name="ga4ApiSecret"
                  autoComplete="off"
                  type="password"
                  value={ga4Secret}
                  onChange={setGa4Secret}
                  helpText={hasGa4Secret ? "A secret is saved. Enter a new one to replace it." : "GA4, Admin, Data Streams, Measurement Protocol API secrets."}
                />
                <TextField
                  label="Meta CAPI access token"
                  name="metaCapiToken"
                  autoComplete="off"
                  type="password"
                  value={capiToken}
                  onChange={setCapiToken}
                  helpText={hasCapiToken ? "A token is saved. Enter a new one to replace it." : "Meta Events Manager, your dataset, Settings, Conversions API, Generate access token."}
                />
                <TextField
                  label="Server-side GTM container URL"
                  name="gtmServerUrl"
                  autoComplete="off"
                  type="url"
                  value={gtmUrl}
                  onChange={setGtmUrl}
                  placeholder="https://sgtm.yourdomain.com"
                  helpText="Required for GTM events. A web container (GTM-XXXX) can't load in the pixel sandbox, so GTM events are delivered to your server-side GTM container's GA4 client. Leave blank to disable GTM."
                />
                <InlineStack>
                  <Button submit variant="primary" loading={busy} disabled={!dirty}>Save keys</Button>
                </InlineStack>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Verify GA4"
              description="Send a pixelify_test event straight to GA4 using the saved secret, then watch it land in GA4 DebugView. The fastest way to confirm credentials work."
            />
            <BlockStack gap="150">
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={hasGa4Id ? "success" : "attention"}>{hasGa4Id ? "GA4 ID set" : "GA4 ID missing"}</Badge>
                <Text as="span" tone="subdued" variant="bodySm">Measurement ID on the Tracking page</Text>
              </InlineStack>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={serverSideOn ? "success" : "attention"}>{serverSideOn ? "Server-side on" : "Server-side off"}</Badge>
                <Text as="span" tone="subdued" variant="bodySm">Server-side delivery toggle on the Tracking page</Text>
              </InlineStack>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={hasGa4Secret ? "success" : "attention"}>{hasGa4Secret ? "Secret saved" : "Secret missing"}</Badge>
                <Text as="span" tone="subdued" variant="bodySm">GA4 Measurement Protocol secret above</Text>
              </InlineStack>
            </BlockStack>
            <InlineStack gap="200" blockAlign="center">
              <Form method="post">
                <input type="hidden" name="intent" value="test" />
                <Button submit loading={busy} disabled={!canTest}>Send GA4 test event</Button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="test_purchase" />
                <Button submit loading={busy} disabled={!canTest}>Send test purchase</Button>
              </Form>
              {!canTest && <Button url="/app/tracking" variant="plain">Open Tracking</Button>}
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
