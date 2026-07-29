import { useLoaderData, useActionData, useNavigation, useFetcher, Form } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Banner, Button, Badge, Divider, TextField, ProgressBar, Link as PolarisLink } from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { readServerSideKeys, writeServerSideKeys } from "../lib/secrets.server";
import { wizardState } from "../lib/wizard";
import { syncWebPixel } from "../lib/web-pixel.server";
import { validateGa4Event, sendGa4Event } from "../lib/server-side.server";
import { logActivity } from "../lib/activity.server";

// Plain-language, hand-holding setup for non-technical merchants. They only ever paste two values (GA4
// measurement ID + secret); the wizard turns on server-side delivery, sets a sensible event matrix and
// creates the Web Pixel for them. The advanced Tracking/Settings pages stay for anyone who wants them.

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain: session.shop } });
  const keys = readServerSideKeys(tracking);
  return { state: wizardState(tracking, keys), shop: session.shop };
};

// Ensure the GA4 event matrix includes the two events that matter, without discarding anything already set.
function withGa4Defaults(existingMatrixJson) {
  let m = {};
  try {
    m = JSON.parse(existingMatrixJson || "{}");
  } catch {
    m = {};
  }
  const ga4 = new Set(Array.isArray(m.ga4) ? m.ga4 : []);
  ga4.add("page_viewed");
  ga4.add("checkout_completed");
  return JSON.stringify({ ...m, ga4: [...ga4] });
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const existing = await prisma.trackingSettings.findUnique({ where: { shopDomain } });

  // Step 1 — Connect GA4. We do the technical bits (server-side on, event matrix, create the pixel) for them.
  if (intent === "connect_ga4") {
    const ga4Id = (form.get("ga4Id") || "").trim();
    if (!/^G-[A-Z0-9]{6,}$/i.test(ga4Id)) {
      return { error: "That doesn't look like a GA4 Measurement ID. It should look like G-XXXXXXXXXX." };
    }
    const eventMatrix = withGa4Defaults(existing?.eventMatrix);
    await prisma.trackingSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, ga4Id, serverSide: true, eventMatrix },
      update: { ga4Id, serverSide: true, eventMatrix },
    });
    // Create/update the Web Pixel so the storefront starts sending — the same path the Tracking page uses.
    const appHost = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
    const { webPixelId, pixelError } = await syncWebPixel({
      admin,
      appHost,
      shopDomain,
      existingId: existing?.webPixelId,
      config: { ga4Id, eventMatrix: JSON.parse(eventMatrix), consentMode: existing?.consentMode ?? true, consentSignals: existing?.consentSignals ?? true, debug: existing?.pixelDebug ?? false },
    });
    if (webPixelId && webPixelId !== existing?.webPixelId) {
      await prisma.trackingSettings.update({ where: { shopDomain }, data: { webPixelId } });
    }
    await logActivity(shopDomain, "Setup wizard: connected GA4");
    return { ok: true, pixelError: pixelError || null };
  }

  // Step 2 — Save the GA4 secret (encrypted, merged with any existing keys).
  if (intent === "save_secret") {
    const secret = (form.get("ga4ApiSecret") || "").trim();
    if (!secret) return { error: "Paste the secret value from Google Analytics." };
    const keys = { ...readServerSideKeys(existing), ga4ApiSecret: secret };
    await prisma.trackingSettings.update({ where: { shopDomain }, data: { serverSideKeys: writeServerSideKeys(keys) } });
    await logActivity(shopDomain, "Setup wizard: saved GA4 secret");
    return { ok: true };
  }

  // Step 3 — Live test (does not need the theme embed; that's a storefront-only capture leg).
  if (intent === "test") {
    if (!existing?.ga4Id) return { error: "Connect GA4 first." };
    const event = { name: "pixelify_diagnostic", params: { debug_mode: 1, source: "pixelify-wizard" }, clientId: "test.0" };
    const v = await validateGa4Event(existing, event);
    if (!v.ok) return { testOk: false, testDetail: v.messages.join("; ") };
    const r = await sendGa4Event(existing, event);
    await logActivity(shopDomain, `Setup wizard: live test ${r.sent ? "ok" : "failed"}`);
    return { testOk: !!r.sent, testDetail: r.sent ? "GA4 accepted the test event — you're all set." : r.detail || "Send failed." };
  }

  return { error: "Unknown step." };
};

function StepHeader({ step, total, title }) {
  return (
    <BlockStack gap="200">
      <InlineStack gap="200" blockAlign="center">
        <Badge tone="info">{`Step ${step} of ${total}`}</Badge>
        <div style={{ flex: 1, minWidth: 120 }}>
          <ProgressBar progress={Math.round(((step - 1) / total) * 100)} size="small" />
        </div>
      </InlineStack>
      <Text as="h2" variant="headingLg">{title}</Text>
    </BlockStack>
  );
}

export default function Wizard() {
  const { state, shop } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [ga4Id, setGa4Id] = useState("");
  const [secret, setSecret] = useState("");
  const testFetcher = useFetcher();

  // Deep link to the theme editor's App embeds panel (opens Shopify admin in a new tab).
  const embedUrl = `https://${shop}/admin/themes/current/editor?context=apps`;

  if (state.complete) {
    return (
      <Page title="Setup" subtitle="Your tracking is live.">
        <Card>
          <BlockStack gap="300">
            <Banner tone="success" title="You're all set">
              GA4 is connected, server-side delivery is on, and the Web Pixel is installed. Purchases and
              events are now being sent to Google Analytics.
            </Banner>
            <InlineStack gap="300">
              <Button url="/app/attribution">See your attribution</Button>
              <Button url="/app/accuracy" variant="plain">Check accuracy</Button>
              <Button url="/app/tracking" variant="plain">Add more destinations (Meta, TikTok…)</Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Set up your tracking" subtitle="A few short steps. We'll handle the technical parts for you.">
      <BlockStack gap="400">
        {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}
        {actionData?.pixelError && (
          <Banner tone="warning" title="Connected, but the storefront pixel needs a moment">
            {actionData.pixelError} — this usually clears on its own; you can carry on.
          </Banner>
        )}

        {state.step === 1 && (
          <Card>
            <BlockStack gap="400">
              <StepHeader step={1} total={state.total} title="Connect Google Analytics 4" />
              <Text as="p">
                Paste your Google Analytics Measurement ID below. That&apos;s the only thing we need to start —
                we&apos;ll switch everything else on for you.
              </Text>
              <Form method="post">
                <input type="hidden" name="intent" value="connect_ga4" />
                <BlockStack gap="300">
                  <TextField
                    label="Google Analytics Measurement ID"
                    name="ga4Id"
                    autoComplete="off"
                    value={ga4Id}
                    onChange={setGa4Id}
                    placeholder="G-XXXXXXXXXX"
                    helpText="Where to find it: in Google Analytics, click Admin (the cog, bottom-left) → Data streams → click your website → the Measurement ID (G-…) is at the top right."
                  />
                  <InlineStack>
                    <Button submit variant="primary" loading={busy}>Connect and continue</Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        )}

        {state.step === 2 && (
          <Card>
            <BlockStack gap="400">
              <StepHeader step={2} total={state.total} title="Add your secret key" />
              <Text as="p">
                One more value from Google Analytics. This lets us send your sales to GA4 securely from our
                server (which is what keeps your data flowing past ad blockers and on the checkout).
              </Text>
              <Form method="post">
                <input type="hidden" name="intent" value="save_secret" />
                <BlockStack gap="300">
                  <TextField
                    label="GA4 Measurement Protocol secret"
                    name="ga4ApiSecret"
                    autoComplete="off"
                    type="password"
                    value={secret}
                    onChange={setSecret}
                    helpText="Where to find it: in Google Analytics → Admin → Data streams → click your website → scroll to “Measurement Protocol API secrets” → Create → copy the Secret value and paste it here."
                  />
                  <InlineStack gap="200">
                    <Button submit variant="primary" loading={busy}>Save and continue</Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        )}

        {state.step === 3 && (
          <Card>
            <BlockStack gap="400">
              <StepHeader step={3} total={state.total} title="Turn on the storefront add-on, then test" />
              <Text as="p">
                Last thing: switch on the app in your theme so it can track visitors browsing your store.
              </Text>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  1. Click the button below (it opens your theme editor in a new tab).
                </Text>
                <Text as="p" variant="bodyMd">
                  2. In the panel that opens, find <b>Pixelify SEO engagement</b> and switch it <b>on</b>.
                </Text>
                <Text as="p" variant="bodyMd">3. Click <b>Save</b> in the theme editor, then come back here.</Text>
                <InlineStack>
                  <Button url={embedUrl} target="_blank" variant="primary">Open my theme editor</Button>
                </InlineStack>
              </BlockStack>
              <Divider />
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Check it&apos;s working</Text>
                <Text as="p">
                  Send a test to Google Analytics to confirm the connection. (This checks the connection, not
                  the theme switch above — that one only affects live storefront visitors.)
                </Text>
                <testFetcher.Form method="post">
                  <input type="hidden" name="intent" value="test" />
                  <InlineStack gap="200" blockAlign="center">
                    <Button submit loading={testFetcher.state !== "idle"}>Send test to GA4</Button>
                    {testFetcher.data?.testOk === true && <Badge tone="success">Passed</Badge>}
                    {testFetcher.data?.testOk === false && <Badge tone="critical">Failed</Badge>}
                  </InlineStack>
                </testFetcher.Form>
                {testFetcher.data?.testDetail && (
                  <Text as="p" variant="bodySm" tone={testFetcher.data?.testOk ? "subdued" : "critical"}>
                    {testFetcher.data.testDetail}
                  </Text>
                )}
                {testFetcher.data?.testOk && (
                  <InlineStack gap="300">
                    <Button url="/app/attribution" variant="primary">Finish — see your data</Button>
                  </InlineStack>
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        <Text as="p" variant="bodySm" tone="subdued">
          Prefer to do it yourself? The <PolarisLink url="/app/tracking">Tracking</PolarisLink> and{" "}
          <PolarisLink url="/app/settings">Settings</PolarisLink> pages have every option. You can also{" "}
          <PolarisLink url="/app">skip to the dashboard</PolarisLink>.
        </Text>
      </BlockStack>
    </Page>
  );
}
