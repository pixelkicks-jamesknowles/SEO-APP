import { useState, useRef, useEffect } from "react";
import { useLoaderData, useActionData, Form, useNavigation, useSubmit } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, TextField, Button, Banner } from "@shopify/polaris";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logActivity } from "../lib/activity.server";
import { sendGa4Event } from "../lib/server-side.server";
import { SectionHeading } from "../components/SectionHeading";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain: session.shop } });
  const keys = JSON.parse(tracking?.serverSideKeys || "{}");
  return {
    hasGa4Secret: Boolean(keys.ga4ApiSecret),
    hasCapiToken: Boolean(keys.metaCapiToken),
    gtmServerUrl: keys.gtmServerUrl || "",
    canTest: Boolean(tracking?.serverSide && tracking?.ga4Id && keys.ga4ApiSecret),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();

  // Send a live GA4 test event (verifies the secret end-to-end; appears in GA4 DebugView).
  if (form.get("intent") === "test") {
    const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain } });
    if (!tracking?.serverSide) return { testError: "Turn on Server-side delivery on the Tracking page first." };
    if (!tracking?.ga4Id) return { testError: "Add a GA4 measurement ID on the Tracking page first." };
    const res = await sendGa4Event(tracking, {
      name: "pixelify_test",
      params: { debug_mode: 1, source: "pixelify-admin" },
      clientId: "test.0",
    });
    await logActivity(shopDomain, "Sent GA4 test event");
    return res.sent
      ? { testOk: "Sent a pixelify_test event to GA4. Open GA4, Admin, DebugView - it appears within a few seconds." }
      : { testError: "Send failed. Check the GA4 Measurement Protocol secret below and that GA4 + Server-side are configured." };
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
  const { hasGa4Secret, hasCapiToken, gtmServerUrl: savedGtmUrl, canTest } = useLoaderData();
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
            <Form method="post">
              <input type="hidden" name="intent" value="test" />
              <InlineStack gap="200" blockAlign="center">
                <Button submit loading={busy} disabled={!canTest}>Send GA4 test event</Button>
                {!canTest && (
                  <Text as="span" tone="subdued" variant="bodySm">
                    Needs GA4 + Server-side on (Tracking) and a saved GA4 secret above.
                  </Text>
                )}
              </InlineStack>
            </Form>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
