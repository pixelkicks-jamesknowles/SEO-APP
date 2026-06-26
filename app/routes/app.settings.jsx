import { useState } from "react";
import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import { Page, Card, BlockStack, Text, TextField, Button, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logActivity } from "../lib/activity.server";
import { SectionHeading } from "../components/SectionHeading";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain: session.shop } });
  const keys = JSON.parse(tracking?.serverSideKeys || "{}");
  const exportConfig = tracking && {
    gtmId: tracking.gtmId,
    ga4Id: tracking.ga4Id,
    metaPixelId: tracking.metaPixelId,
    tiktokPixelId: tracking.tiktokPixelId,
    pinterestId: tracking.pinterestId,
    snapPixelId: tracking.snapPixelId,
    bingUetId: tracking.bingUetId,
    eventMatrix: JSON.parse(tracking.eventMatrix || "{}"),
    consentMode: tracking.consentMode,
    subscriptionTracking: tracking.subscriptionTracking,
    subscriptionConfig: JSON.parse(tracking.subscriptionConfig || "{}"),
  };
  return {
    exportConfig,
    hasGa4Secret: Boolean(keys.ga4ApiSecret),
    hasCapiToken: Boolean(keys.metaCapiToken),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "import") {
    let t;
    try {
      t = JSON.parse(form.get("config") || "");
    } catch {
      return { error: "That isn't valid JSON." };
    }
    const data = {
      gtmId: t.gtmId || null,
      ga4Id: t.ga4Id || null,
      metaPixelId: t.metaPixelId || null,
      tiktokPixelId: t.tiktokPixelId || null,
      pinterestId: t.pinterestId || null,
      snapPixelId: t.snapPixelId || null,
      bingUetId: t.bingUetId || null,
      eventMatrix: JSON.stringify(t.eventMatrix || {}),
      consentMode: t.consentMode !== false,
      subscriptionTracking: Boolean(t.subscriptionTracking),
      subscriptionConfig: JSON.stringify(t.subscriptionConfig || {}),
    };
    await prisma.trackingSettings.upsert({ where: { shopDomain }, create: { shopDomain, ...data }, update: data });
    await logActivity(shopDomain, "Imported tracking configuration");
    return { ok: "Configuration imported. Re-open Tracking to see it." };
  }

  if (intent === "savekeys") {
    const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain } });
    const keys = JSON.parse(tracking?.serverSideKeys || "{}");
    if (form.get("ga4ApiSecret")) keys.ga4ApiSecret = form.get("ga4ApiSecret");
    if (form.get("metaCapiToken")) keys.metaCapiToken = form.get("metaCapiToken");
    const serverSideKeys = JSON.stringify(keys);
    await prisma.trackingSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, serverSideKeys },
      update: { serverSideKeys },
    });
    await logActivity(shopDomain, "Saved server-side keys");
    return { ok: "Server-side keys saved." };
  }

  return null;
};

export default function Settings() {
  const { exportConfig, hasGa4Secret, hasCapiToken } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const [config, setConfig] = useState("");
  const [ga4Secret, setGa4Secret] = useState("");
  const [capiToken, setCapiToken] = useState("");

  return (
    <Page title="Settings" subtitle="Server-side keys and tracking config export/import.">
      <BlockStack gap="400">
        {actionData?.ok && <Banner tone="success">{actionData.ok}</Banner>}
        {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Server-side tracking keys"
              help="Credentials for server-side delivery — the GA4 Measurement Protocol secret (also used by the subscription event) and the Meta CAPI token."
            />
            <Text as="p" tone="subdued">Used by server-side fan-out (GA4 Measurement Protocol + Meta CAPI).</Text>
            <Form method="post">
              <input type="hidden" name="intent" value="savekeys" />
              <BlockStack gap="200">
                <TextField
                  label="GA4 API secret"
                  name="ga4ApiSecret"
                  autoComplete="off"
                  type="password"
                  value={ga4Secret}
                  onChange={setGa4Secret}
                  helpText={hasGa4Secret ? "A secret is saved. Enter a new one to replace it." : "GA4 Admin → Data Streams → Measurement Protocol API secrets."}
                />
                <TextField
                  label="Meta CAPI access token"
                  name="metaCapiToken"
                  autoComplete="off"
                  type="password"
                  value={capiToken}
                  onChange={setCapiToken}
                  helpText={hasCapiToken ? "A token is saved. Enter a new one to replace it." : undefined}
                />
                <Button submit variant="primary" loading={busy}>Save keys</Button>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading title="Export configuration" help="Copy your tracking setup as JSON to clone it onto another store." />
            <TextField label="Config JSON" labelHidden multiline={6} readOnly autoComplete="off" value={JSON.stringify(exportConfig, null, 2)} />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading title="Import configuration" help="Paste a previously exported tracking config to apply it here." />
            <Form method="post">
              <input type="hidden" name="intent" value="import" />
              <BlockStack gap="200">
                <TextField label="Paste config JSON" multiline={6} autoComplete="off" name="config" value={config} onChange={setConfig} />
                <Button submit loading={busy}>Import</Button>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
