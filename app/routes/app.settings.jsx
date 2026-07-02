import { useState, useRef, useEffect } from "react";
import { useLoaderData, useActionData, Form, useNavigation, useSubmit } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, TextField, Button, Banner, Badge, Checkbox } from "@shopify/polaris";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logActivity } from "../lib/activity.server";
import { fanOutServerSide, validateGa4Event, ga4EventFor } from "../lib/server-side.server";
import { buildSubscriptionEvent } from "../lib/subscription";
import { recordDeliveries } from "../lib/delivery.server";
import { readServerSideKeys, writeServerSideKeys } from "../lib/secrets.server";
import { EVENT_SAMPLES, SUBSCRIPTION_SAMPLE } from "../lib/event-samples";
import { googleAdsEnvReady, googleAdsConnected, googleAdsConfigOf, googleAdsDisconnect, googleAuthUrl, googleRedirectUri, createOAuthState } from "../lib/google-ads.server";
import { SectionHeading } from "../components/SectionHeading";

const DEST_LABEL = { ga4: "GA4", meta: "Meta CAPI", gtm: "Server-side GTM" };

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain: session.shop } });
  const keys = readServerSideKeys(tracking);
  const gaCfg = googleAdsConfigOf(tracking);
  return {
    hasGa4Secret: Boolean(keys.ga4ApiSecret),
    hasCapiToken: Boolean(keys.metaCapiToken),
    gtmServerUrl: keys.gtmServerUrl || "",
    hasGa4Id: Boolean(tracking?.ga4Id),
    serverSideOn: Boolean(tracking?.serverSide),
    canTest: Boolean(tracking?.serverSide && tracking?.ga4Id && keys.ga4ApiSecret),
    // Google Ads (gated): only surface the card when the operator has configured the env credentials.
    googleAdsEnv: googleAdsEnvReady(),
    googleAdsEnabled: Boolean(tracking?.googleAdsEnabled),
    googleAdsConnected: await googleAdsConnected(session.shop),
    googleAdsConfig: { customerId: gaCfg.customerId || "", loginCustomerId: gaCfg.loginCustomerId || "", conversionActionId: gaCfg.conversionActionId || "" },
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();

  // Send a live GA4 test event (verifies the secret end-to-end; appears in GA4 DebugView).
  const intent = form.get("intent");
  if (intent === "test" || intent === "test_purchase" || intent === "test_subscription") {
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
    } else if (intent === "test_subscription") {
      // Subscription-shaped payload from the orders/paid path (carries subscription + interval + items).
      // Distinctly named + test transaction_id so it can't collide with real subscription data.
      const sub = buildSubscriptionEvent(SUBSCRIPTION_SAMPLE.order, {
        eventName: "pixelify_test_subscription",
        monthDays: 28,
        clientId: "test.0",
        attribution: SUBSCRIPTION_SAMPLE.attribution,
      });
      event = { name: sub.name, params: { ...sub.params, transaction_id: "PIXELIFY-TEST-SUB", debug_mode: 1 }, clientId: "test.0" };
    } else {
      event = { name: "pixelify_test", params: { debug_mode: 1, source: "pixelify-admin" }, clientId: "test.0" };
    }

    // Validate the GA4 payload first (the real endpoint always returns 204, even for a bad secret).
    const v = await validateGa4Event(tracking, event);
    if (!v.ok) {
      return { testError: `GA4 rejected the event: ${v.messages.join("; ")}. Check the measurement ID and secret belong to the same data stream.` };
    }
    // Send through the REAL fan-out (force = bypass the event matrix) so it exercises GA4 + Meta CAPI
    // + server-side GTM, and logs each outcome to Delivery health.
    const results = await fanOutServerSide(tracking, event, { force: true });
    await recordDeliveries(shopDomain, results);
    await logActivity(shopDomain, `Sent ${intent} to ${results.length} destination(s)`);

    const summary = results.map((r) => `${DEST_LABEL[r.destination] || r.destination} ${r.ok ? "ok" : `failed (${r.detail})`}`).join(", ");
    const allOk = results.length > 0 && results.every((r) => r.ok);
    const scope = {
      test_purchase: "purchase-shaped (items + value)",
      test_subscription: "subscription-shaped (subscription + interval + items)",
      test: "a simple test",
    }[intent];
    if (!allOk) {
      return { testError: `Some destinations failed - ${summary}. Fix the failing credential, then retry.` };
    }
    return {
      testOk: `Sent ${scope} test event to every configured destination: ${summary}. Check GA4 Realtime / DebugView (and Meta Test Events), and the Delivery health panel on Live events. This verifies your credentials + the server-side pipeline; it does not test the storefront checkout capture, which needs a real checkout on a deployed store.`,
    };
  }

  // Google Ads (gated): connect (return the OAuth URL for the client to open), disconnect, or save config.
  if (intent === "googleConnect") {
    if (!googleAdsEnvReady()) return { gadsError: "Google Ads isn't enabled on this app (missing operator credentials)." };
    const authUrl = googleAuthUrl(googleRedirectUri(), await createOAuthState(shopDomain));
    return { googleAuthUrl: authUrl };
  }
  if (intent === "googleDisconnect") {
    await googleAdsDisconnect(shopDomain);
    await logActivity(shopDomain, "Disconnected Google Ads");
    return { ok: "Google account disconnected." };
  }
  if (intent === "googleConfig") {
    const cfg = {
      customerId: (form.get("gadsCustomerId") || "").replace(/\D/g, "") || null,
      loginCustomerId: (form.get("gadsLoginCustomerId") || "").replace(/\D/g, "") || null,
      conversionActionId: (form.get("gadsConversionActionId") || "").replace(/\D/g, "") || null,
    };
    const enabled = form.get("gadsEnabled") === "on" && !!cfg.customerId && !!cfg.conversionActionId;
    await prisma.trackingSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, googleAdsEnabled: enabled, googleAdsConfig: JSON.stringify(cfg) },
      update: { googleAdsEnabled: enabled, googleAdsConfig: JSON.stringify(cfg) },
    });
    await logActivity(shopDomain, `Saved Google Ads config (enabled=${enabled})`);
    return { ok: "Google Ads settings saved." };
  }

  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain } });
  const keys = readServerSideKeys(tracking);
  if (form.get("ga4ApiSecret")) keys.ga4ApiSecret = form.get("ga4ApiSecret");
  if (form.get("metaCapiToken")) keys.metaCapiToken = form.get("metaCapiToken");
  const gtmServerUrl = (form.get("gtmServerUrl") || "").trim();
  if (gtmServerUrl) keys.gtmServerUrl = gtmServerUrl;
  else delete keys.gtmServerUrl;
  const serverSideKeys = writeServerSideKeys(keys);
  await prisma.trackingSettings.upsert({
    where: { shopDomain },
    create: { shopDomain, serverSideKeys },
    update: { serverSideKeys },
  });
  await logActivity(shopDomain, "Saved server-side keys");
  return { ok: "Server-side keys saved." };
};

export default function Settings() {
  const { hasGa4Secret, hasCapiToken, gtmServerUrl: savedGtmUrl, hasGa4Id, serverSideOn, canTest, googleAdsEnv, googleAdsEnabled, googleAdsConnected: gadsConnected, googleAdsConfig } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const keysForm = useRef(null);

  const [ga4Secret, setGa4Secret] = useState("");
  const [capiToken, setCapiToken] = useState("");
  const [gtmUrl, setGtmUrl] = useState(savedGtmUrl);
  const [gads, setGads] = useState(googleAdsConfig || { customerId: "", loginCustomerId: "", conversionActionId: "" });
  const [gadsEnabled, setGadsEnabled] = useState(Boolean(googleAdsEnabled));
  const setGadsField = (k) => (v) => setGads((s) => ({ ...s, [k]: v.replace(/\D/g, "") }));

  // Which form is submitting, if any — so each button only spins for its OWN submit (the page has six
  // forms). The keys form carries no `intent`, so a submit without one is the "save-keys" action.
  const submitting = nav.state !== "idle" ? (nav.formData?.get("intent") ?? "save-keys") : null;
  const busy = (intent) => submitting === intent;
  const dirty = ga4Secret !== "" || capiToken !== "" || gtmUrl !== savedGtmUrl;

  // When the connect action returns an OAuth URL, open Google consent in a new tab (top-level — it
  // can't run inside the embedded iframe).
  useEffect(() => {
    if (actionData?.googleAuthUrl) window.open(actionData.googleAuthUrl, "_blank", "noopener");
  }, [actionData]);

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
      primaryAction={{ content: "Save", onAction: saveNow, loading: busy("save-keys"), disabled: !dirty }}
    >
      <SaveBar id="settings-save">
        <button variant="primary" onClick={saveNow}>Save</button>
        <button onClick={discard}>Discard</button>
      </SaveBar>
      <BlockStack gap="400">
        {actionData?.ok && <Banner tone="success">{actionData.ok}</Banner>}
        {actionData?.testOk && <Banner tone="success">{actionData.testOk}</Banner>}
        {actionData?.testError && <Banner tone="warning">{actionData.testError}</Banner>}
        {actionData?.gadsError && <Banner tone="warning">{actionData.gadsError}</Banner>}
        {actionData?.googleAuthUrl && <Banner tone="info">Opening Google sign-in in a new tab. After you connect, return here and set your customer ID + conversion action below.</Banner>}

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
                  <Button submit variant="primary" loading={busy("save-keys")} disabled={!dirty}>Save keys</Button>
                </InlineStack>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>

        {googleAdsEnv && (
          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Google Ads Enhanced Conversions"
                description="Upload purchases straight to Google Ads (matched on the on-page gclid and/or hashed customer data), in addition to the GA4 path. Connect your Google account, then set the customer ID and conversion action."
              />
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={gadsConnected ? "success" : "attention"}>{gadsConnected ? "Google connected" : "Not connected"}</Badge>
                <Badge tone={gadsEnabled && gadsConnected ? "success" : undefined}>{gadsEnabled ? "Uploads on" : "Uploads off"}</Badge>
              </InlineStack>
              <InlineStack gap="200">
                <Form method="post">
                  <input type="hidden" name="intent" value="googleConnect" />
                  <Button submit loading={busy("googleConnect")}>{gadsConnected ? "Reconnect Google" : "Connect Google"}</Button>
                </Form>
                {gadsConnected && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="googleDisconnect" />
                    <Button submit tone="critical" variant="plain" loading={busy("googleDisconnect")}>Disconnect</Button>
                  </Form>
                )}
              </InlineStack>
              <Form method="post">
                <input type="hidden" name="intent" value="googleConfig" />
                <input type="hidden" name="gadsEnabled" value={gadsEnabled ? "on" : ""} />
                <BlockStack gap="200">
                  <TextField label="Customer ID" name="gadsCustomerId" autoComplete="off" value={gads.customerId} onChange={setGadsField("customerId")} placeholder="1234567890" helpText="Your Google Ads account ID (digits only, no dashes)." />
                  <TextField label="Login customer ID (optional)" name="gadsLoginCustomerId" autoComplete="off" value={gads.loginCustomerId} onChange={setGadsField("loginCustomerId")} placeholder="Manager (MCC) account ID, if any" helpText="Only if you access this account through a manager (MCC) account." />
                  <TextField label="Conversion action ID" name="gadsConversionActionId" autoComplete="off" value={gads.conversionActionId} onChange={setGadsField("conversionActionId")} placeholder="987654321" helpText="Google Ads → Goals → the conversion action's ID (the digits in its resource name)." />
                  <InlineStack gap="200" blockAlign="center">
                    <Button submit variant="primary" loading={busy("googleConfig")}>Save Google Ads settings</Button>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {gadsConnected ? "Uploads turn on once a customer ID + conversion action are saved." : "Connect your Google account first."}
                    </Text>
                  </InlineStack>
                  <Checkbox
                    label="Enable uploads"
                    checked={gadsEnabled}
                    onChange={setGadsEnabled}
                    disabled={!gadsConnected}
                  />
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Verify delivery"
              description="Sends a distinctly-named test event to every configured destination (GA4, Meta CAPI, server-side GTM) and logs the result to Delivery health. Confirms your credentials and the server-side pipeline work. It does not test the storefront checkout capture - that needs a real checkout on a deployed store."
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
                <Button submit loading={busy("test")} disabled={!canTest}>Send test event</Button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="test_purchase" />
                <Button submit loading={busy("test_purchase")} disabled={!canTest}>Send test purchase</Button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="test_subscription" />
                <Button submit loading={busy("test_subscription")} disabled={!canTest}>Send test subscription</Button>
              </Form>
              {!canTest && <Button url="/app/tracking" variant="plain">Open Tracking</Button>}
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
