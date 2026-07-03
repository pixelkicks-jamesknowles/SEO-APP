import { useLoaderData, useActionData, Form, useNavigation, useSubmit } from "@remix-run/react";
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
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { useState, useRef, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logActivity } from "../lib/activity.server";
import { SectionHeading } from "../components/SectionHeading";
import { eventLabel } from "../lib/event-labels";
import { pixelToken } from "../lib/pixel-token.server";
import { readServerSideKeys } from "../lib/secrets.server";

// Build the matrix[platform][event] = boolean map from saved settings.
function buildMatrix(data) {
  const m = {};
  for (const { key } of PLATFORMS) {
    m[key] = Object.fromEntries(EVENTS.map((e) => [e, (data.eventMatrix[key] || []).includes(e)]));
  }
  return m;
}

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
// Destinations, grouped for the matrix header: browser-tag platforms (fired client-side by the Web
// Pixel) vs conversions-API platforms (fired server-side from the /track beacon). PLATFORMS is the flat
// list every other bit of logic (buildMatrix, save loop, ids) still iterates.
const PLATFORM_GROUPS = [
  { label: "Client tags", platforms: [
    { key: "gtm", label: "GTM" },
    { key: "ga4", label: "GA4" },
    { key: "meta", label: "Meta" },
  ] },
  { label: "Server-side APIs", platforms: [
    { key: "tiktok", label: "TikTok" },
    { key: "pinterest", label: "Pinterest" },
    { key: "snapchat", label: "Snapchat" },
    { key: "reddit", label: "Reddit" },
    { key: "linkedin", label: "LinkedIn" },
    { key: "klaviyo", label: "Klaviyo" },
  ] },
];
const PLATFORMS = PLATFORM_GROUPS.flatMap((g) => g.platforms);
// The first platform key of each group after the first — draws the vertical divider between groups.
const GROUP_START_KEYS = new Set(PLATFORM_GROUPS.slice(1).map((g) => g.platforms[0].key));
const GROUP_DIVIDER = "1px solid var(--p-color-border)";
// Freeze the event-name column so it stays visible while the (now wider) destination grid scrolls.
const stickyCol = (z) => ({ position: "sticky", left: 0, zIndex: z, background: "var(--p-color-bg-surface)" });

// Klaviyo only ingests onsite browse/abandonment events; every other event is a no-op for it (its
// builder returns nothing), so those cells are shown disabled rather than tickable-but-ignored. Every
// other destination sends all events (unmapped ones pass through as a custom event).
const KLAVIYO_EVENTS = new Set(["product_viewed", "product_added_to_cart", "checkout_started"]);
function destSupports(platform, event) {
  return platform === "klaviyo" ? KLAVIYO_EVENTS.has(event) : true;
}

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
  const keys = readServerSideKeys(t);
  return {
    hasGa4Secret: Boolean(keys.ga4ApiSecret),
    hasCapiToken: Boolean(keys.metaCapiToken),
    gtmId: t?.gtmId ?? "",
    ga4Id: t?.ga4Id ?? "",
    metaPixelId: t?.metaPixelId ?? "",
    tiktokPixelId: t?.tiktokPixelId ?? "",
    pinterestId: t?.pinterestId ?? "",
    snapPixelId: t?.snapPixelId ?? "",
    redditPixelId: t?.redditPixelId ?? "",
    linkedinConversionId: t?.linkedinConversionId ?? "",
    hasTiktokToken: Boolean(keys.tiktokAccessToken),
    hasPinterestToken: Boolean(keys.pinterestAccessToken && keys.pinterestAdAccountId),
    hasSnapToken: Boolean(keys.snapAccessToken),
    hasRedditToken: Boolean(keys.redditAccessToken),
    hasLinkedinToken: Boolean(keys.linkedinAccessToken),
    eventMatrix: JSON.parse(t?.eventMatrix ?? "{}"),
    consentMode: t?.consentMode ?? true,
    consentSignals: t?.consentSignals ?? true,
    serverSide: t?.serverSide ?? false,
    subscriptionTracking: t?.subscriptionTracking ?? false,
    subscriptionConfig: JSON.parse(t?.subscriptionConfig ?? "{}"),
    pixelDebug: t?.pixelDebug ?? false,
    refundTracking: t?.refundTracking ?? false,
    botFiltering: t?.botFiltering ?? true,
    valueMode: t?.valueMode ?? "revenue",
    marginPct: t?.marginPct ?? 0,
    reportingCurrency: t?.reportingCurrency ?? "",
    fxMode: t?.fxMode ?? "off",
    lifecycleTracking: t?.lifecycleTracking ?? false,
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
  // Margin mode with a 0% margin would send `value: 0` for every conversion — a silent
  // under-reporting trap. Only honour "margin" when a real percent is set; else stay on revenue.
  const marginPct = Math.max(0, Math.min(100, Math.round(Number(form.get("marginPct")) || 0)));
  const valueMode = form.get("valueMode") === "margin" && marginPct > 0 ? "margin" : "revenue";
  // Multi-currency: only honour "on" when a reporting currency (3-letter ISO) is actually set.
  const reportingCurrency = (form.get("reportingCurrency") || "").trim().toUpperCase().slice(0, 3) || null;
  const fxMode = form.get("fxMode") === "on" && reportingCurrency ? "on" : "off";
  const data = {
    gtmId: form.get("gtmId") || null,
    ga4Id: form.get("ga4Id") || null,
    metaPixelId: form.get("metaPixelId") || null,
    tiktokPixelId: form.get("tiktokPixelId") || null,
    pinterestId: form.get("pinterestId") || null,
    snapPixelId: form.get("snapPixelId") || null,
    redditPixelId: form.get("redditPixelId") || null,
    linkedinConversionId: form.get("linkedinConversionId") || null,
    eventMatrix: JSON.stringify(eventMatrix),
    consentMode: form.get("consentMode") === "on",
    consentSignals: form.get("consentSignals") === "on",
    pixelDebug: form.get("pixelDebug") === "on",
    refundTracking: form.get("refundTracking") === "on",
    botFiltering: form.get("botFiltering") === "on",
    serverSide: form.get("serverSide") === "on",
    valueMode,
    marginPct,
    reportingCurrency,
    fxMode,
    lifecycleTracking: form.get("lifecycleTracking") === "on",
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
  // One JSON field - the extension declares a single non-blank `config` field, so individual
  // platform IDs can be left blank (e.g. GA4-only) without Shopify's "can't be blank" rejection.
  // The Web Pixel's strict sandbox blocks same-origin requests, so it CANNOT use the app proxy - it
  // must beacon cross-origin to the app's own host. Hard-code that absolute URL (+ the shop, since a
  // direct request carries no app-proxy signature) into the pixel config here.
  const appHost = (process.env.SHOPIFY_APP_URL || new URL(request.url).origin).replace(/\/$/, "");
  const pixelSettings = {
    config: JSON.stringify({
      gtmId: data.gtmId || "",
      ga4Id: data.ga4Id || "",
      metaPixelId: data.metaPixelId || "",
      eventMatrix: JSON.parse(data.eventMatrix || "{}"),
      consentMode: data.consentMode,
      consentSignals: data.consentSignals,
      debug: data.pixelDebug,
      trackUrl: `${appHost}/pixel/track`,
      shopDomain,
      // Shop-scoped token so /pixel/track (an unsigned cross-origin beacon) can reject forged events
      // for arbitrary shops. See app/lib/pixel-token.server.js for what this does and doesn't buy.
      trackToken: pixelToken(shopDomain),
    }),
  };
  const input = { settings: JSON.stringify(pixelSettings) };

  let webPixelId = existing?.webPixelId || null;
  let pixelError = null;
  const createPixel = async () => {
    const res = await admin.graphql(CREATE_PIXEL, { variables: { webPixel: input } });
    const json = await res.json();
    const errs = json.data?.webPixelCreate?.userErrors ?? [];
    if (errs.length) pixelError = errs.map((e) => e.message).join("; ");
    else webPixelId = json.data?.webPixelCreate?.webPixel?.id ?? null;
  };
  try {
    if (webPixelId) {
      const res = await admin.graphql(UPDATE_PIXEL, { variables: { id: webPixelId, webPixel: input } });
      const json = await res.json();
      const errs = json.data?.webPixelUpdate?.userErrors ?? [];
      // The stored pixel can vanish (app reinstall, dev-store reset, manual delete). When the update
      // can't find it, drop the stale ID and create a fresh pixel so the save self-heals.
      if (errs.some((e) => /couldn't be found|could not be found|does not exist/i.test(e.message))) {
        webPixelId = null;
        await createPixel();
      } else if (errs.length) {
        pixelError = errs.map((e) => e.message).join("; ");
      }
    } else {
      await createPixel();
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
  // Scope the loading state to THIS form's POST so an unrelated navigation/revalidation (or a
  // fetcher elsewhere) doesn't flip the Save buttons into a spinner.
  const saving = nav.state === "submitting" && nav.formMethod === "POST";

  // Local matrix state: matrix[platform][event] = boolean
  const [matrix, setMatrix] = useState(() => buildMatrix(data));
  const [consent, setConsent] = useState(data.consentMode);
  const [consentSignals, setConsentSignals] = useState(data.consentSignals);
  const [debug, setDebug] = useState(data.pixelDebug);
  const seoHas = (e) => (data.eventMatrix.ga4 || []).includes(e) || (data.eventMatrix.gtm || []).includes(e);
  const [scrollDepth, setScrollDepth] = useState(seoHas("scroll"));
  const [engagedView, setEngagedView] = useState(seoHas("engaged_view"));
  const [serverSide, setServerSide] = useState(data.serverSide);
  const [refundTracking, setRefundTracking] = useState(data.refundTracking);
  const [botFiltering, setBotFiltering] = useState(data.botFiltering);
  const [valueMode, setValueMode] = useState(data.valueMode);
  const [marginPct, setMarginPct] = useState(String(data.marginPct ?? 0));
  const [fxOn, setFxOn] = useState(data.fxMode === "on");
  const [reportingCurrency, setReportingCurrency] = useState(data.reportingCurrency ?? "");
  const [lifecycleTracking, setLifecycleTracking] = useState(data.lifecycleTracking);
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
    redditPixelId: data.redditPixelId,
    linkedinConversionId: data.linkedinConversionId,
  });
  const setId = (k) => (v) => setIds((s) => ({ ...s, [k]: v }));

  const toggle = (p, e) => {
    if (!destSupports(p, e)) return; // unsupported cell — never toggles on
    setMatrix((m) => ({ ...m, [p]: { ...m[p], [e]: !m[p][e] } }));
  };

  // Per-column select-all, over the events the destination actually supports: if every supported event
  // is already on, clear the column; otherwise select all supported ones (unsupported stay off).
  const supportedEvents = (p) => EVENTS.filter((e) => destSupports(p, e));
  const columnAllOn = (p) => supportedEvents(p).every((e) => matrix[p]?.[e]);
  const toggleColumn = (p) =>
    setMatrix((m) => {
      const turnOn = !supportedEvents(p).every((e) => m[p]?.[e]);
      return { ...m, [p]: Object.fromEntries(EVENTS.map((e) => [e, destSupports(p, e) ? turnOn : false])) };
    });

  // --- Contextual save bar (App Bridge): show on unsaved changes, hide after save/discard. ---
  const shopify = useAppBridge();
  const submit = useSubmit();
  const formRef = useRef(null);
  const snapshotOf = () =>
    JSON.stringify({ matrix, consent, consentSignals, debug, scrollDepth, engagedView, serverSide, refundTracking, botFiltering, valueMode, marginPct, fxOn, reportingCurrency, lifecycleTracking, subTracking, subCfg, ids });
  const snapshot = snapshotOf();
  const baseline = useRef(snapshot);
  const dirty = snapshot !== baseline.current;

  useEffect(() => {
    if (dirty) shopify.saveBar.show("tracking-save");
    else shopify.saveBar.hide("tracking-save");
  }, [dirty, shopify]);

  useEffect(() => {
    if (actionData?.ok && nav.state === "idle") {
      baseline.current = snapshotOf();
      shopify.saveBar.hide("tracking-save");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData, nav.state]);

  const discard = () => {
    setMatrix(buildMatrix(data));
    setConsent(data.consentMode);
    setConsentSignals(data.consentSignals);
    setDebug(data.pixelDebug);
    setScrollDepth(seoHas("scroll"));
    setEngagedView(seoHas("engaged_view"));
    setServerSide(data.serverSide);
    setRefundTracking(data.refundTracking);
    setBotFiltering(data.botFiltering);
    setValueMode(data.valueMode);
    setMarginPct(String(data.marginPct ?? 0));
    setFxOn(data.fxMode === "on");
    setReportingCurrency(data.reportingCurrency ?? "");
    setLifecycleTracking(data.lifecycleTracking);
    setSubTracking(data.subscriptionTracking);
    setSubCfg({
      eventName: data.subscriptionConfig.eventName ?? "subscription_purchase",
      monthDays: String(data.subscriptionConfig.monthDays ?? 28),
      clientIdMode: data.subscriptionConfig.clientIdMode ?? "synthetic",
    });
    setIds({ gtmId: data.gtmId, ga4Id: data.ga4Id, metaPixelId: data.metaPixelId, tiktokPixelId: data.tiktokPixelId, pinterestId: data.pinterestId, snapPixelId: data.snapPixelId, redditPixelId: data.redditPixelId, linkedinConversionId: data.linkedinConversionId });
  };
  const saveNow = () => submit(formRef.current, { method: "post" });

  // Inline config validation - catch the "set up but sends nothing" traps.
  const idsSet = !!(ids.gtmId || ids.ga4Id || ids.metaPixelId || ids.tiktokPixelId || ids.pinterestId || ids.snapPixelId || ids.redditPixelId || ids.linkedinConversionId);
  const deliveryOffWarn = idsSet && !serverSide;
  const ga4SecretWarn = serverSide && !!ids.ga4Id && !data.hasGa4Secret;
  const metaTokenWarn = serverSide && !!ids.metaPixelId && !data.hasCapiToken;

  return (
    <Page
      title="Tracking"
      subtitle="Send GTM, GA4 and Meta events via the Web Pixels API, consent-gated."
      primaryAction={{ content: "Save", onAction: saveNow, loading: saving, disabled: !dirty }}
    >
      <SaveBar id="tracking-save">
        <button variant="primary" onClick={saveNow}>Save</button>
        <button onClick={discard}>Discard</button>
      </SaveBar>
      <Form method="post" ref={formRef}>
        <BlockStack gap="400">
          {actionData?.ok && !actionData?.pixelError && (
            <Banner tone="success">Saved - web pixel synced.</Banner>
          )}
          {actionData?.pixelError && (
            <Banner tone="warning" title="Saved, but the web pixel didn’t sync">
              {actionData.pixelError}
            </Banner>
          )}
          {deliveryOffWarn && (
            <Banner tone="warning" title="Nothing will be sent yet">
              You&apos;ve added destination IDs, but <b>Server-side delivery</b> is off. Turn it on below
              for events to actually send.
            </Banner>
          )}
          {(ga4SecretWarn || metaTokenWarn) && (
            <Banner tone="warning" title="Missing server-side credentials">
              {ga4SecretWarn && <p>GA4 is set but has no Measurement Protocol secret - add it on Settings.</p>}
              {metaTokenWarn && <p>Meta is set but has no CAPI token - add it on Settings.</p>}
            </Banner>
          )}

          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Destinations"
                description="Paste each platform's ID. Leave one blank to disable that destination. Events fire via Shopify's Web Pixels API, which also covers checkout and purchase."
                help="GTM here is a web container ID for reference; server-side GTM delivery uses the container URL on Settings."
              />
              <FormLayout>
                <FormLayout.Group>
                  <TextField label="GTM container ID" name="gtmId" autoComplete="off" value={ids.gtmId} onChange={setId("gtmId")} placeholder="GTM-XXXXXXX" error={idError("gtm", ids.gtmId)} />
                  <TextField label="GA4 measurement ID" name="ga4Id" autoComplete="off" value={ids.ga4Id} onChange={setId("ga4Id")} placeholder="G-XXXXXXXXXX" error={idError("ga4", ids.ga4Id)} />
                </FormLayout.Group>
                <TextField label="Meta Pixel ID" name="metaPixelId" autoComplete="off" value={ids.metaPixelId} onChange={setId("metaPixelId")} />
                <FormLayout.Group>
                  <TextField
                    label="TikTok Pixel ID"
                    name="tiktokPixelId"
                    autoComplete="off"
                    value={ids.tiktokPixelId}
                    onChange={setId("tiktokPixelId")}
                    placeholder="C4XXXXXXXXXXXXXXXXXX"
                    helpText={data.hasTiktokToken ? "Delivered server-side via the TikTok Events API." : "Add a TikTok Events API access token on Settings to deliver these."}
                  />
                  <TextField
                    label="Pinterest tag ID"
                    name="pinterestId"
                    autoComplete="off"
                    value={ids.pinterestId}
                    onChange={setId("pinterestId")}
                    placeholder="2612345678901"
                    helpText={data.hasPinterestToken ? "Delivered server-side via the Pinterest Conversions API." : "Add a Pinterest CAPI token + ad account ID on Settings to deliver these."}
                  />
                  <TextField
                    label="Snapchat Pixel ID"
                    name="snapPixelId"
                    autoComplete="off"
                    value={ids.snapPixelId}
                    onChange={setId("snapPixelId")}
                    helpText={data.hasSnapToken ? "Delivered server-side via the Snapchat Conversions API." : "Add a Snapchat Conversions API token on Settings to deliver these."}
                  />
                  <TextField
                    label="Reddit Pixel ID"
                    name="redditPixelId"
                    autoComplete="off"
                    value={ids.redditPixelId}
                    onChange={setId("redditPixelId")}
                    placeholder="a2_abcdef123456"
                    helpText={data.hasRedditToken ? "Delivered server-side via the Reddit Conversions API." : "Add a Reddit Conversions API token on Settings to deliver these."}
                  />
                  <TextField
                    label="LinkedIn conversion ID"
                    name="linkedinConversionId"
                    autoComplete="off"
                    value={ids.linkedinConversionId}
                    onChange={setId("linkedinConversionId")}
                    placeholder="12345678"
                    helpText={data.hasLinkedinToken ? "Delivered server-side (B2B) via the LinkedIn Conversions API." : "Add a LinkedIn Conversions API token on Settings to deliver these."}
                  />
                </FormLayout.Group>
              </FormLayout>
            </BlockStack>
          </Card>

          <Card padding="0">
            <div style={{ padding: "var(--p-space-400)" }}>
              <SectionHeading
                title="Events"
                description="Tick which events each destination receives. Because it uses Web Pixels, checkout and purchase are covered - which theme scripts can't reach."
              />
            </div>
            <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
                Per-destination event opt-in matrix
              </caption>
              <thead>
                {/* Group row: browser tags vs server-side conversions APIs. */}
                <tr>
                  <td style={stickyCol(2)} />
                  {PLATFORM_GROUPS.map((g, gi) => (
                    <th
                      key={g.label}
                      scope="colgroup"
                      colSpan={g.platforms.length}
                      style={{ textAlign: "center", padding: "var(--p-space-200) var(--p-space-200) var(--p-space-050)", borderLeft: gi > 0 ? GROUP_DIVIDER : undefined }}
                    >
                      <Text as="span" variant="bodyXs" tone="subdued" fontWeight="medium">{g.label}</Text>
                    </th>
                  ))}
                </tr>
                <tr>
                  <th scope="col" style={{ ...stickyCol(2), textAlign: "left", padding: "var(--p-space-100) var(--p-space-400)" }}>
                    <Text as="span" variant="bodySm" tone="subdued">Event</Text>
                  </th>
                  {PLATFORMS.map((p) => (
                    <th
                      key={p.key}
                      scope="col"
                      style={{ textAlign: "center", padding: "var(--p-space-100) var(--p-space-200)", borderLeft: GROUP_START_KEYS.has(p.key) ? GROUP_DIVIDER : undefined }}
                    >
                      <BlockStack gap="050" inlineAlign="center">
                        <Text as="span" variant="bodySm" tone="subdued">{p.label}</Text>
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
                    <th scope="row" style={{ ...stickyCol(1), textAlign: "left", fontWeight: "normal", padding: "var(--p-space-150) var(--p-space-400)", whiteSpace: "nowrap" }}>
                      <Text as="span" variant="bodyMd">{eventLabel(e)}</Text>
                    </th>
                    {PLATFORMS.map((p) => {
                      const supported = destSupports(p.key, e);
                      return (
                        <td key={p.key} style={{ padding: "var(--p-space-100) var(--p-space-200)", borderLeft: GROUP_START_KEYS.has(p.key) ? GROUP_DIVIDER : undefined }}>
                          <div style={{ display: "flex", justifyContent: "center" }}>
                            {supported ? (
                              <>
                                {matrix[p.key][e] && <input type="hidden" name={`evt:${p.key}:${e}`} value="on" />}
                                <Checkbox
                                  label={`${p.label}: ${eventLabel(e)}`}
                                  labelHidden
                                  checked={matrix[p.key][e]}
                                  onChange={() => toggle(p.key, e)}
                                />
                              </>
                            ) : (
                              <span
                                title={`${p.label} doesn’t receive ${eventLabel(e)}`}
                                aria-label={`${p.label} does not support ${eventLabel(e)}`}
                                style={{ cursor: "help", color: "var(--p-color-text-disabled)" }}
                              >
                                &ndash;
                              </span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div style={{ padding: "var(--p-space-300) var(--p-space-400) var(--p-space-400)" }}>
              <Text as="p" variant="bodySm" tone="subdued">
                <b>Klaviyo</b> only receives the onsite events above, and only for shoppers it can identify
                (logged-in or post-email). Placed Order stays with Klaviyo&rsquo;s native Shopify integration,
                so it isn&rsquo;t double-counted. Add a private API key on Settings to deliver these.
              </Text>
            </div>
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
                label="Scroll depth - GA4 “scroll” events at each threshold (percent_scrolled)"
                checked={scrollDepth}
                onChange={setScrollDepth}
              />
              <input type="hidden" name="evt:ga4:engaged_view" value={engagedView ? "on" : ""} />
              <input type="hidden" name="evt:gtm:engaged_view" value={engagedView ? "on" : ""} />
              <Checkbox
                label="Engaged-content views - “engaged_view” when a visitor reads (time on page + scroll)"
                helpText="Lets SEO teams see which content actually gets consumed, not just landed on. Thresholds are configured on the app embed."
                checked={engagedView}
                onChange={setEngagedView}
              />
            </BlockStack>
          </Card>

          {/* Delivery — the master switch + delivery hygiene + the testing toggle. */}
          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Delivery"
                help="How events reach your platforms. Server-side delivery (GA4 Measurement Protocol / Meta CAPI) is required for anything to send, and survives ad blockers, Safari ITP and the checkout sandbox."
              />
              {/* Polaris Checkbox doesn't post a form value, so a hidden input carries each toggle. */}
              <input type="hidden" name="serverSide" value={serverSide ? "on" : ""} />
              <Checkbox
                label="Server-side delivery (Meta CAPI / GA4 Measurement Protocol)"
                helpText="Required for anything to send. Events are delivered server-side for accuracy + ad-blocker resilience."
                checked={serverSide}
                onChange={setServerSide}
              />
              <input type="hidden" name="botFiltering" value={botFiltering ? "on" : ""} />
              <Checkbox
                label="Bot filtering - drop known bots and headless agents before delivery"
                helpText="Stops crawler/headless traffic (often 20-30% of hits) from reaching ad platforms as fake conversions. Recommended on."
                checked={botFiltering}
                onChange={setBotFiltering}
              />
              <input type="hidden" name="pixelDebug" value={debug ? "on" : ""} />
              <Checkbox
                label="Debug mode - log every event to the storefront browser console"
                helpText="For testing: confirm events fire without configuring any platform. Open the storefront, DevTools → Console, look for “[pixelify-tracking]”. Turn off in production."
                checked={debug}
                onChange={setDebug}
              />
            </BlockStack>
          </Card>

          {/* Consent */}
          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Consent"
                help="Gate every tag behind the Customer Privacy (consent) API. Consent Mode v2 lets GA4 model conversions from visitors who decline."
              />
              <input type="hidden" name="consentMode" value={consent ? "on" : ""} />
              <Checkbox
                label="Consent mode - respect the Customer Privacy API (recommended)"
                checked={consent}
                onChange={setConsent}
              />
              <input type="hidden" name="consentSignals" value={consentSignals ? "on" : ""} />
              <Checkbox
                label="Google Consent Mode v2 - keep sending consent-flagged events without consent"
                helpText="Recommended for EEA/UK. Instead of dropping events when a visitor declines, send a privacy-safe, flagged hit so GA4 can model the missing conversions (Meta is skipped without marketing consent). Untick for strict gating - nothing fires until consent is granted."
                checked={consentSignals}
                disabled={!consent}
                onChange={setConsentSignals}
              />
            </BlockStack>
          </Card>

          {/* Conversion tracking — value mode + server-side order conversions (need Server-side delivery). */}
          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Conversion tracking"
                help="What conversion value to optimise for, plus server-side purchase / refund / subscription events from order webhooks. Requires Server-side delivery."
              />
              <input type="hidden" name="valueMode" value={valueMode} />
              <input type="hidden" name="marginPct" value={marginPct || "0"} />
              <Select
                label="Optimise conversions for"
                options={[
                  { label: "Revenue (order value)", value: "revenue" },
                  { label: "Margin (profit)", value: "margin" },
                ]}
                value={valueMode}
                onChange={setValueMode}
                disabled={!serverSide}
                helpText="Margin sends value × margin% as the conversion value (raw revenue kept as a 'revenue' param), so ad platforms optimise for profit. Applies to purchase + refund; subscription_purchase keeps raw revenue."
              />
              {valueMode === "margin" && serverSide ? (
                <TextField
                  label="Margin %"
                  type="number"
                  autoComplete="off"
                  min={0}
                  max={100}
                  suffix="%"
                  value={marginPct}
                  onChange={setMarginPct}
                  error={Number(marginPct) > 0 ? undefined : "Set a margin above 0% — otherwise revenue is used."}
                  helpText="Whole percent, e.g. 40 = send 40% of revenue as the conversion value."
                />
              ) : null}
              <input type="hidden" name="refundTracking" value={refundTracking && serverSide ? "on" : ""} />
              <Checkbox
                label="Refund & cancellation tracking - send a GA4 refund event from refunds/orders cancelled"
                helpText={
                  serverSide
                    ? "Nets refunds off your conversions in GA4 (and Google Ads via import), so campaigns stop optimising toward high-return orders."
                    : "Enable Server-side delivery above first."
                }
                checked={refundTracking && serverSide}
                disabled={!serverSide}
                onChange={setRefundTracking}
              />
              <input type="hidden" name="subscriptionTracking" value={subTracking && serverSide ? "on" : ""} />
              <Checkbox
                label="Subscription conversion tracking - send a server-side subscription_purchase event from orders/paid"
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

              <input type="hidden" name="lifecycleTracking" value={lifecycleTracking && serverSide ? "on" : ""} />
              <Checkbox
                label="Post-purchase & lifecycle events — order edits and fulfillments"
                helpText={
                  serverSide
                    ? "Sends a GA4 refund/purchase adjustment when an order's total changes (orders/edited), and an order_fulfilled event on fulfillment — so post-purchase changes stay reflected in your analytics."
                    : "Enable Server-side above first."
                }
                checked={lifecycleTracking && serverSide}
                disabled={!serverSide}
                onChange={setLifecycleTracking}
              />

              <input type="hidden" name="fxMode" value={fxOn && serverSide ? "on" : ""} />
              <Checkbox
                label="Normalise conversion value to a single reporting currency"
                helpText={
                  serverSide
                    ? "Converts every conversion's value into the currency below before delivery, so ad platforms optimise on comparable numbers across markets. The original amount is kept as an 'original_value' / 'original_currency' param. Rates refresh daily."
                    : "Enable Server-side above first."
                }
                checked={fxOn && serverSide}
                disabled={!serverSide}
                onChange={setFxOn}
              />
              {fxOn && serverSide ? (
                <TextField
                  label="Reporting currency"
                  name="reportingCurrency"
                  autoComplete="off"
                  maxLength={3}
                  value={reportingCurrency}
                  onChange={(v) => setReportingCurrency(v.toUpperCase().slice(0, 3))}
                  placeholder="USD"
                  error={reportingCurrency.length === 3 ? undefined : "Enter a 3-letter ISO currency code (e.g. USD)."}
                  helpText="ISO 4217 code, e.g. USD, EUR, GBP."
                />
              ) : (
                <input type="hidden" name="reportingCurrency" value={reportingCurrency} />
              )}
            </BlockStack>
          </Card>

          <InlineStack align="end">
            {/* Same behaviour as the page/SaveBar actions: dirty-gated, routed through saveNow. */}
            <Button variant="primary" onClick={saveNow} loading={saving} disabled={!dirty}>
              Save
            </Button>
          </InlineStack>
        </BlockStack>
      </Form>
    </Page>
  );
}
