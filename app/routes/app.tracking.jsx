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
  return {
    gtmId: t?.gtmId ?? "",
    ga4Id: t?.ga4Id ?? "",
    metaPixelId: t?.metaPixelId ?? "",
    eventMatrix: JSON.parse(t?.eventMatrix ?? "{}"),
    consentMode: t?.consentMode ?? true,
    consentSignals: t?.consentSignals ?? true,
    serverSide: t?.serverSide ?? false,
    subscriptionTracking: t?.subscriptionTracking ?? false,
    subscriptionConfig: JSON.parse(t?.subscriptionConfig ?? "{}"),
    pixelDebug: t?.pixelDebug ?? false,
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
  // SEO engagement events (scroll / engaged_view) come from the theme app embed, not the pixel, and
  // only make sense for GA4 + GTM. Driven by the two checkboxes below.
  for (const key of ["ga4", "gtm"]) {
    for (const e of ["scroll", "engaged_view"]) {
      if (form.get(`evt:${key}:${e}`) === "on") eventMatrix[key].push(e);
    }
  }
  const data = {
    gtmId: form.get("gtmId") || null,
    ga4Id: form.get("ga4Id") || null,
    metaPixelId: form.get("metaPixelId") || null,
    eventMatrix: JSON.stringify(eventMatrix),
    consentMode: form.get("consentMode") === "on",
    consentSignals: form.get("consentSignals") === "on",
    pixelDebug: form.get("pixelDebug") === "on",
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
  // One JSON field — the extension declares a single non-blank `config` field, so individual
  // platform IDs can be left blank (e.g. GA4-only) without Shopify's "can't be blank" rejection.
  const pixelSettings = {
    config: JSON.stringify({
      gtmId: data.gtmId || "",
      ga4Id: data.ga4Id || "",
      metaPixelId: data.metaPixelId || "",
      eventMatrix: JSON.parse(data.eventMatrix || "{}"),
      consentMode: data.consentMode,
      consentSignals: data.consentSignals,
      debug: data.pixelDebug,
      // App-proxy path the pixel beacons server-side events to. Must match [app_proxy] prefix/subpath
      // in shopify.app.toml. The pixel resolves it against the live storefront origin at send time,
      // so no deployed host needs to be hard-coded here.
      proxyPath: "/apps/pixelify-seo/track",
    }),
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
  const [consentSignals, setConsentSignals] = useState(data.consentSignals);
  const [debug, setDebug] = useState(data.pixelDebug);
  const seoHas = (e) => (data.eventMatrix.ga4 || []).includes(e) || (data.eventMatrix.gtm || []).includes(e);
  const [scrollDepth, setScrollDepth] = useState(seoHas("scroll"));
  const [engagedView, setEngagedView] = useState(seoHas("engaged_view"));
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
  });
  const setId = (k) => (v) => setIds((s) => ({ ...s, [k]: v }));

  const toggle = (p, e) =>
    setMatrix((m) => ({ ...m, [p]: { ...m[p], [e]: !m[p][e] } }));

  // Per-column select-all: if every event is already on, clear the column; otherwise select all.
  const columnAllOn = (p) => EVENTS.every((e) => matrix[p]?.[e]);
  const toggleColumn = (p) =>
    setMatrix((m) => {
      const turnOn = !EVENTS.every((e) => m[p]?.[e]);
      return { ...m, [p]: Object.fromEntries(EVENTS.map((e) => [e, turnOn])) };
    });

  return (
    <Page
      title="Tracking"
      subtitle="GTM, GA4 and Meta — fired via the Web Pixels API, consent-gated."
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

          <Banner tone="info" title="Avoiding double-counting with the Google & YouTube app">
            <p>
              If the store runs the native Google &amp; YouTube app, it already sends the standard GA4
              ecommerce events (incl. <b>purchase</b>). Server-side events here de-dup safely —
              GA4 collapses purchases on matching <b>transaction_id</b> and Meta de-dups on{" "}
              <b>event_id</b> — but for other events, prefer to track here only what the native app
              doesn&apos;t. GTM events require a server-side GTM container URL on the Settings page
              (a web GTM-XXXX container can&apos;t load in the pixel sandbox).
            </p>
            <p>
              <b>Google Ads:</b> no setup needed here — the server-side GA4 purchase carries the right
              client_id, so it stitches to the on-page session that holds the gclid. Link your GA4
              property to Google Ads and import the purchase conversion (no API or developer token).
            </p>
          </Banner>

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
                <TextField label="Meta Pixel ID" name="metaPixelId" autoComplete="off" value={ids.metaPixelId} onChange={setId("metaPixelId")} />
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
                      <BlockStack gap="050" inlineAlign="center">
                        <Text as="span" variant="bodySm" tone="subdued">
                          {p.label}
                        </Text>
                        <Button variant="plain" size="micro" onClick={() => toggleColumn(p.key)}>
                          {columnAllOn(p.key) ? "Clear" : "All"}
                        </Button>
                      </BlockStack>
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
                title="SEO engagement (GA4 & GTM)"
                help="Scroll depth and engaged-content views aren't Shopify customer events, so they're captured by the “Pixelify SEO engagement” app embed (enable it in Theme editor → App embeds) and forwarded server-side to GA4/GTM. These toggles control whether the server forwards them."
              />
              <Text as="p" tone="subdued">
                Enable the <b>Pixelify SEO engagement</b> app embed in your theme, then choose what to forward.
                Sent to GA4/GTM only (not Meta). Requires Server-side on below.
              </Text>
              <input type="hidden" name="evt:ga4:scroll" value={scrollDepth ? "on" : ""} />
              <input type="hidden" name="evt:gtm:scroll" value={scrollDepth ? "on" : ""} />
              <Checkbox
                label="Scroll depth — GA4 “scroll” events at each threshold (percent_scrolled)"
                checked={scrollDepth}
                onChange={setScrollDepth}
              />
              <input type="hidden" name="evt:ga4:engaged_view" value={engagedView ? "on" : ""} />
              <input type="hidden" name="evt:gtm:engaged_view" value={engagedView ? "on" : ""} />
              <Checkbox
                label="Engaged-content views — “engaged_view” when a visitor reads (time on page + scroll)"
                helpText="Lets SEO teams see which content actually gets consumed, not just landed on. Thresholds are configured on the app embed."
                checked={engagedView}
                onChange={setEngagedView}
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Consent & delivery"
                help="Gate every tag behind the Customer Privacy (consent) API, and optionally send events server-side via GA4 Measurement Protocol / Meta CAPI for accuracy and ad-blocker resilience."
              />
              {/* Polaris Checkbox doesn't post a form value, so a hidden input carries each toggle. */}
              <input type="hidden" name="consentMode" value={consent ? "on" : ""} />
              <Checkbox
                label="Consent mode — respect the Customer Privacy API (recommended)"
                checked={consent}
                onChange={setConsent}
              />
              <input type="hidden" name="consentSignals" value={consentSignals ? "on" : ""} />
              <Checkbox
                label="Google Consent Mode v2 — keep sending consent-flagged events without consent"
                helpText="Recommended for EEA/UK. Instead of dropping events when a visitor declines, send a privacy-safe, flagged hit so GA4 can model the missing conversions (Meta is skipped without marketing consent). Untick for strict gating — nothing fires until consent is granted."
                checked={consentSignals}
                disabled={!consent}
                onChange={setConsentSignals}
              />
              <input type="hidden" name="pixelDebug" value={debug ? "on" : ""} />
              <Checkbox
                label="Debug mode — log every event to the storefront browser console"
                helpText="For testing: confirm events fire without configuring any platform. Open the storefront, DevTools → Console, look for “[pixelify-tracking]”. Turn off in production."
                checked={debug}
                onChange={setDebug}
              />
              <input type="hidden" name="serverSide" value={serverSide ? "on" : ""} />
              <Checkbox
                label="Server-side (Meta CAPI / GA4 Measurement Protocol)"
                helpText="Events also sent server-side for accuracy + ad-blocker resilience."
                checked={serverSide}
                onChange={setServerSide}
              />
              <input type="hidden" name="subscriptionTracking" value={subTracking && serverSide ? "on" : ""} />
              <Checkbox
                label="Subscription conversion tracking — send a server-side subscription_purchase event from orders/paid"
                helpText={
                  serverSide
                    ? "Requires the GA4 Measurement Protocol API secret on the Settings page. Carries subscription / subscription_interval (per-order + per-line) and the actual discounted amount."
                    : "Enable Server-side above first."
                }
                checked={subTracking && serverSide}
                disabled={!serverSide}
                onChange={setSubTracking}
              />
              {subTracking && serverSide ? (
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
