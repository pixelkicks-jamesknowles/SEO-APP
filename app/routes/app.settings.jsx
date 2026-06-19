import { useState } from "react";
import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  TextField,
  Checkbox,
  Button,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { PLAN } from "../lib/plans";
import prisma from "../db.server";
import { logActivity } from "../lib/activity.server";
import { SectionHeading } from "../components/SectionHeading";

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const [seo, tracking] = await Promise.all([
    prisma.seoSettings.findUnique({ where: { shopDomain } }),
    prisma.trackingSettings.findUnique({ where: { shopDomain } }),
  ]);
  let isPro = false;
  try {
    isPro = (await billing.check({ plans: [PLAN.PRO], isTest: true })).hasActivePayment;
  } catch {
    // no billing / no subscription
  }
  const exportConfig = {
    seo: seo && {
      metaTemplates: JSON.parse(seo.metaTemplates || "{}"),
      altTemplate: seo.altTemplate,
      schemaToggles: JSON.parse(seo.schemaToggles || "{}"),
      llmsTxtEnabled: seo.llmsTxtEnabled,
      autoApply: seo.autoApply,
    },
    tracking: tracking && {
      gtmId: tracking.gtmId,
      ga4Id: tracking.ga4Id,
      metaPixelId: tracking.metaPixelId,
      tiktokPixelId: tracking.tiktokPixelId,
      pinterestId: tracking.pinterestId,
      snapPixelId: tracking.snapPixelId,
      bingUetId: tracking.bingUetId,
      eventMatrix: JSON.parse(tracking.eventMatrix || "{}"),
      consentMode: tracking.consentMode,
    },
  };
  const keys = JSON.parse(tracking?.serverSideKeys || "{}");
  return {
    exportConfig,
    isPro,
    hasGa4Secret: Boolean(keys.ga4ApiSecret),
    hasCapiToken: Boolean(keys.metaCapiToken),
    robotsRules: seo?.robotsRules ?? "",
    indexnowKey: seo?.indexnowKey ?? null,
    hasCrux: Boolean(seo?.cruxApiKey),
    monitoring: seo?.monitoring ?? false,
    alertWebhook: seo?.alertWebhook ?? "",
    shop: session.shop,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "import") {
    let parsed;
    try {
      parsed = JSON.parse(form.get("config") || "");
    } catch {
      return { error: "That isn't valid JSON." };
    }
    if (parsed.seo) {
      const s = parsed.seo;
      const data = {
        metaTemplates: JSON.stringify(s.metaTemplates || {}),
        altTemplate: s.altTemplate || null,
        schemaToggles: JSON.stringify(s.schemaToggles || {}),
        llmsTxtEnabled: Boolean(s.llmsTxtEnabled),
        autoApply: Boolean(s.autoApply),
      };
      await prisma.seoSettings.upsert({ where: { shopDomain }, create: { shopDomain, ...data }, update: data });
    }
    if (parsed.tracking) {
      const t = parsed.tracking;
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
      };
      await prisma.trackingSettings.upsert({ where: { shopDomain }, create: { shopDomain, ...data }, update: data });
    }
    await logActivity(shopDomain, "Imported configuration");
    return { ok: "Configuration imported. Re-open SEO / Tracking to see it." };
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

  if (intent === "saveseoutil") {
    const robotsRules = form.get("robotsRules") || null;
    await prisma.seoSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, robotsRules },
      update: { robotsRules },
    });
    await logActivity(shopDomain, "Saved robots rules");
    return { ok: "Robots rules saved." };
  }

  if (intent === "genindexnow") {
    const rand = () => Math.random().toString(36).slice(2);
    const key = (rand() + rand() + rand()).slice(0, 32);
    await prisma.seoSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, indexnowKey: key },
      update: { indexnowKey: key },
    });
    await logActivity(shopDomain, "Generated IndexNow key");
    return { ok: "IndexNow key generated." };
  }

  if (intent === "savecrux") {
    const cruxApiKey = form.get("cruxApiKey") || null;
    await prisma.seoSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, cruxApiKey },
      update: { cruxApiKey },
    });
    await logActivity(shopDomain, "Saved CrUX API key");
    return { ok: "CrUX API key saved." };
  }

  if (intent === "savemonitoring") {
    const monitoring = form.get("monitoring") === "on";
    const alertWebhook = form.get("alertWebhook") || null;
    await prisma.seoSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, monitoring, alertWebhook },
      update: { monitoring, alertWebhook },
    });
    await logActivity(shopDomain, "Saved monitoring settings");
    return { ok: "Monitoring settings saved." };
  }

  return null;
};

export default function Settings() {
  const {
    exportConfig,
    isPro,
    hasGa4Secret,
    hasCapiToken,
    robotsRules,
    indexnowKey,
    hasCrux,
    monitoring,
    alertWebhook,
    shop,
  } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const [config, setConfig] = useState("");
  const [ga4Secret, setGa4Secret] = useState("");
  const [capiToken, setCapiToken] = useState("");
  const [robots, setRobots] = useState(robotsRules);
  const [cruxKey, setCruxKey] = useState("");
  const [monitorOn, setMonitorOn] = useState(monitoring);
  const [webhook, setWebhook] = useState(alertWebhook);

  return (
    <Page title="Settings" subtitle="Config export/import, server-side keys, robots, IndexNow, and integrations.">

      <BlockStack gap="400">
        {actionData?.ok && <Banner tone="success">{actionData.ok}</Banner>}
        {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Export configuration"
              help="Copy your SEO + tracking setup as JSON to clone it onto another store."
            />
            <Text as="p" tone="subdued">
              Copy this to clone the setup to another store.
            </Text>
            <TextField
              label="Config JSON"
              labelHidden
              multiline={6}
              readOnly
              autoComplete="off"
              value={JSON.stringify(exportConfig, null, 2)}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Import configuration"
              help="Paste a previously exported config to apply it to this store."
            />
            <Form method="post">
              <input type="hidden" name="intent" value="import" />
              <BlockStack gap="200">
                <TextField
                  label="Paste config JSON"
                  multiline={6}
                  autoComplete="off"
                  name="config"
                  value={config}
                  onChange={setConfig}
                />
                <Button submit variant="primary" loading={busy}>
                  Import
                </Button>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Server-side tracking keys"
              help="Credentials for server-side event delivery — the GA4 Measurement Protocol secret and Meta CAPI token. Pro plan."
            />
            <Text as="p" tone="subdued">
              {isPro
                ? "Used by server-side fan-out (GA4 Measurement Protocol + Meta CAPI)."
                : "Pro plan — upgrade on the Plans page to use server-side tracking."}
            </Text>
            <Form method="post">
              <input type="hidden" name="intent" value="savekeys" />
              <BlockStack gap="200">
                <TextField
                  label="GA4 API secret"
                  name="ga4ApiSecret"
                  autoComplete="off"
                  type="password"
                  disabled={!isPro}
                  value={ga4Secret}
                  onChange={setGa4Secret}
                  helpText={hasGa4Secret ? "A secret is saved. Enter a new one to replace it." : undefined}
                />
                <TextField
                  label="Meta CAPI access token"
                  name="metaCapiToken"
                  autoComplete="off"
                  type="password"
                  disabled={!isPro}
                  value={capiToken}
                  onChange={setCapiToken}
                  helpText={hasCapiToken ? "A token is saved. Enter a new one to replace it." : undefined}
                />
                <Button submit disabled={!isPro} loading={busy}>
                  Save keys
                </Button>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Technical SEO"
              help="Manage robots.txt rules and an IndexNow key so changed URLs are pushed to Bing/Yandex for faster indexing."
            />
            <Form method="post">
              <input type="hidden" name="intent" value="saveseoutil" />
              <BlockStack gap="200">
                <TextField
                  label="robots.txt rules"
                  helpText={`Served at https://${shop}/apps/pixelify-seo/robots.txt — reference it from your theme's robots.txt.liquid.`}
                  multiline={4}
                  autoComplete="off"
                  name="robotsRules"
                  value={robots}
                  onChange={setRobots}
                  placeholder={"User-agent: *\nDisallow: /policies/"}
                />
                <Button submit loading={busy}>
                  Save robots rules
                </Button>
              </BlockStack>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="genindexnow" />
              <BlockStack gap="100">
                <Text as="p" variant="bodyMd">
                  IndexNow {indexnowKey ? "(active)" : "(not set)"}
                </Text>
                {indexnowKey && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Key file: https://{shop}/apps/pixelify-seo/indexnow — changed product URLs are
                    submitted to Bing/Yandex automatically.
                  </Text>
                )}
                <Button submit loading={busy}>
                  {indexnowKey ? "Regenerate key" : "Generate key"}
                </Button>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Monitoring & alerts"
              help="Run a scheduled re-audit and post a Slack-compatible alert when your SEO score drops since the last run."
            />
            <Form method="post">
              <input type="hidden" name="intent" value="savemonitoring" />
              <BlockStack gap="200">
                <Checkbox
                  label="Scheduled re-audit — alert when the SEO score drops"
                  name="monitoring"
                  checked={monitorOn}
                  onChange={setMonitorOn}
                />
                <TextField
                  label="Alert webhook (Slack-compatible)"
                  helpText="A regression posts a message here. Leave blank to just record score history."
                  autoComplete="off"
                  name="alertWebhook"
                  value={webhook}
                  onChange={setWebhook}
                  placeholder="https://hooks.slack.com/services/..."
                />
                <Button submit loading={busy}>
                  Save monitoring
                </Button>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Integrations"
              help="Connect external data sources — the Google CrUX API key powers real Core Web Vitals field data on the Web Vitals page."
            />
            <Form method="post">
              <input type="hidden" name="intent" value="savecrux" />
              <BlockStack gap="200">
                <TextField
                  label="Google CrUX API key (Core Web Vitals)"
                  helpText={
                    hasCrux
                      ? "A key is saved. Enter a new one to replace it."
                      : "Enables real field data on the Web Vitals page."
                  }
                  type="password"
                  autoComplete="off"
                  name="cruxApiKey"
                  value={cruxKey}
                  onChange={setCruxKey}
                />
                <Button submit loading={busy}>
                  Save CrUX key
                </Button>
              </BlockStack>
            </Form>
            <Text as="p" tone="subdued" variant="bodySm">
              Google Search Console (performance + indexing) needs OAuth — open the Search Console
              page to connect.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
