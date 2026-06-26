import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  FormLayout,
  Text,
  TextField,
  Select,
  Checkbox,
  Button,
  Banner,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logActivity } from "../lib/activity.server";
import { SectionHeading } from "../components/SectionHeading";

// Shopify standard customer events (Web Pixels API).
const EVENTS = [
  "page_viewed",
  "product_viewed",
  "collection_viewed",
  "search_submitted",
  "product_added_to_cart",
  "checkout_started",
  "payment_info_submitted",
  "checkout_completed",
];
const PLATFORMS = [
  { key: "gtm", label: "GTM" },
  { key: "ga4", label: "GA4" },
  { key: "meta", label: "Meta" },
  { key: "tiktok", label: "TikTok" },
  { key: "pinterest", label: "Pinterest" },
  { key: "snap", label: "Snap" },
  { key: "bing", label: "Bing" },
];

// Light format hints so obviously-wrong IDs are caught before they reach the pixel.
function idError(kind, v) {
  if (!v) return undefined;
  if (kind === "gtm" && !/^GTM-[A-Z0-9]+$/i.test(v)) return "Expected GTM-XXXXXXX";
  if (kind === "ga4" && !/^G-[A-Z0-9]+$/i.test(v)) return "Expected G-XXXXXXXXXX";
  return undefined;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const t = await prisma.trackingSettings.findUnique({
    where: { shopDomain: session.shop },
  });
  const isPro = true; // free app — every feature available
  return {
    gtmId: t?.gtmId ?? "",
    ga4Id: t?.ga4Id ?? "",
    metaPixelId: t?.metaPixelId ?? "",
    tiktokPixelId: t?.tiktokPixelId ?? "",
    pinterestId: t?.pinterestId ?? "",
    snapPixelId: t?.snapPixelId ?? "",
    bingUetId: t?.bingUetId ?? "",
    eventMatrix: JSON.parse(t?.eventMatrix ?? "{}"),
    consentMode: t?.consentMode ?? true,
    serverSide: t?.serverSide ?? false,
    subscriptionTracking: t?.subscriptionTracking ?? false,
    subscriptionConfig: JSON.parse(t?.subscriptionConfig ?? "{}"),
    isPro,
  };
};

const CREATE_PIXEL = `#graphql
  mutation CreateWebPixel($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel { id }
      userErrors { field message }
    }
  }`;

const UPDATE_PIXEL = `#graphql
  mutation UpdateWebPixel($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      webPixel { id }
      userErrors { field message }
    }
  }`;

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const eventMatrix = {};
  for (const { key } of PLATFORMS) {
    eventMatrix[key] = EVENTS.filter((e) => form.get(`evt:${key}:${e}`) === "on");
  }
  const data = {
    gtmId: form.get("gtmId") || null,
    ga4Id: form.get("ga4Id") || null,
    metaPixelId: form.get("metaPixelId") || null,
    tiktokPixelId: form.get("tiktokPixelId") || null,
    pinterestId: form.get("pinterestId") || null,
    snapPixelId: form.get("snapPixelId") || null,
    bingUetId: form.get("bingUetId") || null,
    eventMatrix: JSON.stringify(eventMatrix),
    consentMode: form.get("consentMode") === "on",
    serverSide: form.get("serverSide") === "on",
    subscriptionTracking: form.get("subscriptionTracking") === "on",
    subscriptionConfig: JSON.stringify({
      eventName: form.get("sub_eventName") || "subscription_purchase",
      monthDays: Number(form.get("sub_monthDays")) || 28,
      clientIdMode: form.get("sub_clientIdMode") || "synthetic",
      respectConsent: true,
    }),
  };

  const existing = await prisma.trackingSettings.findUnique({ where: { shopDomain } });
  await prisma.trackingSettings.upsert({
    where: { shopDomain },
    create: { shopDomain, ...data },
    update: data,
  });

  // Push the effective config to the Web Pixel sandbox. Settings keys MUST match the
  // extension's declared fields (extensions/tracking-pixel/shopify.extension.toml).
  const pixelSettings = {
    gtmId: data.gtmId || "",
    ga4Id: data.ga4Id || "",
    metaPixelId: data.metaPixelId || "",
    tiktokPixelId: data.tiktokPixelId || "",
    pinterestId: data.pinterestId || "",
    snapPixelId: data.snapPixelId || "",
    bingUetId: data.bingUetId || "",
    eventMatrix: data.eventMatrix,
    consentMode: String(data.consentMode),
    proxyUrl: "", // set to the app-proxy /track URL once deployed to a real host
  };
  const input = { settings: JSON.stringify(pixelSettings) };

  let webPixelId = existing?.webPixelId || null;
  let pixelError = null;
  try {
    if (webPixelId) {
      const res = await admin.graphql(UPDATE_PIXEL, { variables: { id: webPixelId, webPixel: input } });
      const json = await res.json();
      const errs = json.data?.webPixelUpdate?.userErrors ?? [];
      if (errs.length) pixelError = errs.map((e) => e.message).join("; ");
    } else {
      const res = await admin.graphql(CREATE_PIXEL, { variables: { webPixel: input } });
      const json = await res.json();
      const errs = json.data?.webPixelCreate?.userErrors ?? [];
      if (errs.length) pixelError = errs.map((e) => e.message).join("; ");
      else webPixelId = json.data?.webPixelCreate?.webPixel?.id ?? null;
    }
  } catch (e) {
    pixelError = e.message;
  }

  if (webPixelId && webPixelId !== existing?.webPixelId) {
    await prisma.trackingSettings.update({ where: { shopDomain }, data: { webPixelId } });
  }
  await logActivity(shopDomain, "Saved tracking settings");
  return { ok: true, pixelError };
};

export default function Tracking() {
  const data = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  // Local matrix state: matrix[platform][event] = boolean
  const [matrix, setMatrix] = useState(() => {
    const m = {};
    for (const { key } of PLATFORMS) {
      m[key] = Object.fromEntries(
        EVENTS.map((e) => [e, (data.eventMatrix[key] || []).includes(e)]),
      );
    }
    return m;
  });
  const [consent, setConsent] = useState(data.consentMode);
  const [serverSide, setServerSide] = useState(data.serverSide);
  const [subTracking, setSubTracking] = useState(data.subscriptionTracking);
  const [subCfg, setSubCfg] = useState({
    eventName: data.subscriptionConfig.eventName ?? "subscription_purchase",
    monthDays: String(data.subscriptionConfig.monthDays ?? 28),
    clientIdMode: data.subscriptionConfig.clientIdMode ?? "synthetic",
  });
  const setSub = (k) => (v) => setSubCfg((s) => ({ ...s, [k]: v }));
  const [ids, setIds] = useState({
    gtmId: data.gtmId,
    ga4Id: data.ga4Id,
    metaPixelId: data.metaPixelId,
    tiktokPixelId: data.tiktokPixelId,
    pinterestId: data.pinterestId,
    snapPixelId: data.snapPixelId,
    bingUetId: data.bingUetId,
  });
  const setId = (k) => (v) => setIds((s) => ({ ...s, [k]: v }));

  const toggle = (p, e) =>
    setMatrix((m) => ({ ...m, [p]: { ...m[p], [e]: !m[p][e] } }));

  return (
    <Page
      title="Tracking"
      subtitle="GTM, GA4, Meta, TikTok and more — fired via the Web Pixels API, consent-gated."
    >
      <Form method="post">
        <BlockStack gap="400">
          {actionData?.ok && !actionData?.pixelError && (
            <Banner tone="success">Saved — web pixel synced.</Banner>
          )}
          {actionData?.pixelError && (
            <Banner tone="warning" title="Saved, but the web pixel didn’t sync">
              {actionData.pixelError}
            </Banner>
          )}

          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Tags"
                help="Paste each platform's tracking ID; blank platforms are skipped. Events fire through Shopify's Web Pixels API, which also covers checkout and purchase."
              />
              <Text as="p" tone="subdued">
                Paste each platform&apos;s ID. Leave blank to disable that platform.
              </Text>
              <FormLayout>
                <FormLayout.Group>
                  <TextField label="GTM container ID" name="gtmId" autoComplete="off" value={ids.gtmId} onChange={setId("gtmId")} placeholder="GTM-XXXXXXX" error={idError("gtm", ids.gtmId)} />
                  <TextField label="GA4 measurement ID" name="ga4Id" autoComplete="off" value={ids.ga4Id} onChange={setId("ga4Id")} placeholder="G-XXXXXXXXXX" error={idError("ga4", ids.ga4Id)} />
                </FormLayout.Group>
                <FormLayout.Group>
                  <TextField label="Meta Pixel ID" name="metaPixelId" autoComplete="off" value={ids.metaPixelId} onChange={setId("metaPixelId")} />
                  <TextField label="TikTok Pixel ID" name="tiktokPixelId" autoComplete="off" value={ids.tiktokPixelId} onChange={setId("tiktokPixelId")} />
                </FormLayout.Group>
                <FormLayout.Group>
                  <TextField label="Pinterest Tag ID" name="pinterestId" autoComplete="off" value={ids.pinterestId} onChange={setId("pinterestId")} />
                  <TextField label="Snap Pixel ID" name="snapPixelId" autoComplete="off" value={ids.snapPixelId} onChange={setId("snapPixelId")} />
                </FormLayout.Group>
                <TextField label="Bing UET tag ID" name="bingUetId" autoComplete="off" value={ids.bingUetId} onChange={setId("bingUetId")} />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card padding="0">
            <div style={{ padding: "var(--p-space-400)" }}>
              <SectionHeading
                title="Events to track"
                help="Tick which standard storefront/checkout events each platform receives. Because it uses Web Pixels, checkout and purchase events are covered — which theme scripts can't reach."
              />
              <Text as="p" tone="subdued">
                Tick which events each platform receives. Fired via the Web Pixels API, so
                checkout &amp; purchase are covered.
              </Text>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "var(--p-space-200) var(--p-space-400)" }}>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Event
                    </Text>
                  </th>
                  {PLATFORMS.map((p) => (
                    <th
                      key={p.key}
                      style={{ textAlign: "center", padding: "var(--p-space-200) var(--p-space-300)" }}
                    >
                      <Text as="span" variant="bodySm" tone="subdued">
                        {p.label}
                      </Text>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {EVENTS.map((e) => (
                  <tr key={e} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
                    <td style={{ padding: "var(--p-space-200) var(--p-space-400)" }}>
                      <Text as="span" variant="bodyMd">
                        {e}
                      </Text>
                    </td>
                    {PLATFORMS.map((p) => (
                      <td key={p.key} style={{ padding: "var(--p-space-100) var(--p-space-300)" }}>
                        {matrix[p.key][e] && (
                          <input type="hidden" name={`evt:${p.key}:${e}`} value="on" />
                        )}
                        <div style={{ display: "flex", justifyContent: "center" }}>
                          <Checkbox
                            label={`${p.label} ${e}`}
                            labelHidden
                            checked={matrix[p.key][e]}
                            onChange={() => toggle(p.key, e)}
                          />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Consent & delivery"
                help="Gate every tag behind the Customer Privacy (consent) API, and optionally send events server-side via GA4 Measurement Protocol / Meta CAPI for accuracy and ad-blocker resilience."
              />
              <Checkbox
                label="Consent mode — gate all tags on the Customer Privacy API (recommended)"
                name="consentMode"
                checked={consent}
                onChange={setConsent}
              />
              <Checkbox
                label="Server-side (Meta CAPI / GA4 Measurement Protocol)"
                helpText={
                  data.isPro
                    ? "Events also sent server-side for accuracy + ad-blocker resilience."
                    : "Pro plan — upgrade on the Plans page to enable."
                }
                name="serverSide"
                checked={serverSide && data.isPro}
                disabled={!data.isPro}
                onChange={setServerSide}
              />
              <Checkbox
                label="Subscription conversion tracking — send a server-side subscription_purchase event from orders/paid"
                helpText={
                  serverSide && data.isPro
                    ? "Requires the GA4 Measurement Protocol API secret on the Settings page. Carries subscription / subscription_interval (per-order + per-line) and the actual discounted amount."
                    : "Enable Server-side above (Pro) first."
                }
                name="subscriptionTracking"
                checked={subTracking && serverSide && data.isPro}
                disabled={!serverSide || !data.isPro}
                onChange={setSubTracking}
              />
              {subTracking && serverSide && data.isPro ? (
                <FormLayout>
                  <FormLayout.Group>
                    <TextField label="Event name" name="sub_eventName" autoComplete="off" value={subCfg.eventName} onChange={setSub("eventName")} helpText="Must not be 'purchase' (avoids colliding with the native GA4 purchase)." />
                    <TextField label="Days per month" type="number" name="sub_monthDays" autoComplete="off" value={subCfg.monthDays} onChange={setSub("monthDays")} helpText="How 'monthly' plans map to days (client default 28)." />
                    <Select
                      label="Client ID"
                      name="sub_clientIdMode"
                      options={[
                        { label: "Synthetic (join on transaction_id)", value: "synthetic" },
                        { label: "Cookie (ga_client_id from checkout)", value: "cookie" },
                      ]}
                      value={subCfg.clientIdMode}
                      onChange={setSub("clientIdMode")}
                    />
                  </FormLayout.Group>
                </FormLayout>
              ) : null}
            </BlockStack>
          </Card>

          <InlineStack align="end">
            <Button submit variant="primary" loading={saving}>
              Save
            </Button>
          </InlineStack>
        </BlockStack>
      </Form>
    </Page>
  );
}
