import { useLoaderData, useActionData, useFetcher } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Banner, Button, Badge, Divider, TextField, Checkbox, Select, ProgressBar, Link as PolarisLink } from "@shopify/polaris";
import { useEffect, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { readServerSideKeys, writeServerSideKeys } from "../lib/secrets.server";
import { wizardState } from "../lib/wizard";
import { syncWebPixel } from "../lib/web-pixel.server";
import { validateGa4Event, sendGa4Event } from "../lib/server-side.server";
import { logActivity } from "../lib/activity.server";

// Plain-language, hand-holding setup for non-technical merchants. They only ever paste values and tick
// boxes; the wizard turns on server-side delivery, sets the event matrix and creates the Web Pixel for them.
// 4 steps: GA4 id → GA4 secret → other ad platforms (optional) → enable embed + live test.

const TOTAL = 5;

// Known Shopify subscription apps. Subscription tracking reads Shopify's NATIVE selling-plan data off the
// orders/paid webhook, so it's app-agnostic — apps that use native subscriptions (nearly all) work
// automatically once the toggle is on. The picker is for reassurance + surfacing the one real caveat: an
// app that takes payment on its OWN checkout (outside Shopify) whose renewals may never reach the webhook.
const SUBSCRIPTION_APPS = [
  { value: "shopify", label: "Shopify Subscriptions (native)", ok: true, note: "Fully compatible. Renewals use Shopify's native selling plans, so they're tracked automatically — nothing else to set up." },
  { value: "recharge", label: "Recharge", ok: true, note: "Compatible. Make sure Recharge is on “Shopify Checkout Integration” (its current default) so renewals go through Shopify's native subscriptions — then there's nothing else to do." },
  { value: "bold", label: "Bold Subscriptions", ok: true, note: "Compatible — renewals are tracked automatically via Shopify's native selling plans." },
  { value: "loop", label: "Loop Subscriptions", ok: true, note: "Compatible — tracked automatically via native selling plans." },
  { value: "skio", label: "Skio", ok: true, note: "Compatible — tracked automatically via native selling plans." },
  { value: "seal", label: "Seal Subscriptions", ok: true, note: "Compatible — tracked automatically via native selling plans." },
  { value: "appstle", label: "Appstle Subscriptions", ok: true, note: "Compatible — tracked automatically via native selling plans." },
  { value: "smartrr", label: "Smartrr", ok: true, note: "Compatible — tracked automatically via native selling plans." },
  { value: "stayai", label: "Stay Ai", ok: true, note: "Compatible — tracked automatically via native selling plans." },
  { value: "subify", label: "Subify", ok: true, note: "Compatible — tracked automatically via native selling plans." },
  { value: "paywhirl", label: "PayWhirl", ok: true, note: "Compatible — tracked automatically via native selling plans." },
  { value: "recurpay", label: "Recurpay", ok: true, note: "Compatible — tracked automatically via native selling plans." },
  { value: "propel", label: "Propel Subscriptions", ok: true, note: "Compatible — tracked automatically via native selling plans." },
  { value: "other", label: "Another app / not sure", ok: false, note: "Most subscription apps use Shopify's native selling plans, which we read automatically — so it usually just works. The only exception is an app that takes payment on its OWN checkout (outside Shopify); those renewals may not reach us. If unsure, turn it on and check the Attribution page after your next renewal." },
];

// Server-side destination map: which form field → which TrackingSettings id column / serverSideKeys secret.
const DEST_SERVER = [
  { key: "meta", idField: "metaPixelId", idCol: "metaPixelId", tokenField: "metaCapiToken", keyName: "metaCapiToken" },
  { key: "tiktok", idField: "tiktokPixelId", idCol: "tiktokPixelId", tokenField: "tiktokAccessToken", keyName: "tiktokAccessToken" },
  { key: "pinterest", idField: "pinterestId", idCol: "pinterestId", tokenField: "pinterestAccessToken", keyName: "pinterestAccessToken" },
  { key: "snap", idField: "snapPixelId", idCol: "snapPixelId", tokenField: "snapAccessToken", keyName: "snapAccessToken" },
  { key: "reddit", idField: "redditPixelId", idCol: "redditPixelId", tokenField: "redditAccessToken", keyName: "redditAccessToken" },
  { key: "linkedin", idField: "linkedinConversionId", idCol: "linkedinConversionId", tokenField: "linkedinAccessToken", keyName: "linkedinAccessToken" },
  { key: "bing", idField: "bingUetId", idCol: "bingUetId", tokenField: "bingCapiToken", keyName: "bingCapiToken" },
];
// A sensible funnel most ad-platform CAPIs want (view → add to cart → purchase); the merchant can refine
// on the Tracking page later. checkout_completed is the conversion that matters most.
const DEFAULT_DEST_EVENTS = ["page_viewed", "product_viewed", "product_added_to_cart", "checkout_completed"];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain: session.shop } });
  const keys = readServerSideKeys(tracking);
  const configured = Object.fromEntries(DEST_SERVER.map((d) => [d.key, Boolean(tracking?.[d.idCol])]));
  // ?restart=1 (from the Settings "Re-run setup wizard" button) forces the full step flow again even for an
  // already-configured store, and prefills the non-secret GA4 id so they can breeze past what's done.
  const restart = new URL(request.url).searchParams.get("restart") === "1";
  let subCfg = {};
  try {
    subCfg = JSON.parse(tracking?.subscriptionConfig || "{}");
  } catch {
    subCfg = {};
  }
  return {
    state: wizardState(tracking, keys),
    shop: session.shop,
    configured,
    restart,
    savedGa4Id: tracking?.ga4Id || "",
    subscriptionOn: Boolean(tracking?.subscriptionTracking),
    subscriptionApp: subCfg.app || "shopify",
  };
};

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

async function refreshPixel({ admin, request, shopDomain }) {
  const s = await prisma.trackingSettings.findUnique({ where: { shopDomain } });
  const appHost = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  const { webPixelId, pixelError } = await syncWebPixel({
    admin,
    appHost,
    shopDomain,
    existingId: s?.webPixelId,
    config: {
      gtmId: s?.gtmId,
      ga4Id: s?.ga4Id,
      metaPixelId: s?.metaPixelId,
      eventMatrix: (() => {
        try {
          return JSON.parse(s?.eventMatrix || "{}");
        } catch {
          return {};
        }
      })(),
      consentMode: s?.consentMode ?? true,
      consentSignals: s?.consentSignals ?? true,
      debug: s?.pixelDebug ?? false,
    },
  });
  if (webPixelId && webPixelId !== s?.webPixelId) {
    await prisma.trackingSettings.update({ where: { shopDomain }, data: { webPixelId } });
  }
  return pixelError || null;
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const existing = await prisma.trackingSettings.findUnique({ where: { shopDomain } });

  if (intent === "connect_ga4") {
    const ga4Id = (form.get("ga4Id") || "").trim();
    if (!/^G-[A-Z0-9]{6,}$/i.test(ga4Id)) return { error: "That doesn't look like a GA4 Measurement ID. It should look like G-XXXXXXXXXX." };
    const eventMatrix = withGa4Defaults(existing?.eventMatrix);
    await prisma.trackingSettings.upsert({
      where: { shopDomain },
      create: { shopDomain, ga4Id, serverSide: true, eventMatrix },
      update: { ga4Id, serverSide: true, eventMatrix },
    });
    const pixelError = await refreshPixel({ admin, request, shopDomain });
    await logActivity(shopDomain, "Setup wizard: connected GA4");
    return { ok: true, next: 2, pixelError };
  }

  if (intent === "save_secret") {
    const secret = (form.get("ga4ApiSecret") || "").trim();
    if (!secret) return { error: "Paste the secret value from Google Analytics." };
    const keys = { ...readServerSideKeys(existing), ga4ApiSecret: secret };
    await prisma.trackingSettings.update({ where: { shopDomain }, data: { serverSideKeys: writeServerSideKeys(keys) } });
    await logActivity(shopDomain, "Setup wizard: saved GA4 secret");
    return { ok: true, next: 3 };
  }

  // Optional step 3 — connect ad platforms. Only applies the ones the merchant actually filled in.
  if (intent === "connect_destinations") {
    const keys = readServerSideKeys(existing);
    const settingsUpdate = {};
    const added = [];
    for (const d of DEST_SERVER) {
      const id = (form.get(d.idField) || "").trim();
      if (!id) continue;
      settingsUpdate[d.idCol] = id;
      const token = (form.get(d.tokenField) || "").trim();
      if (token) keys[d.keyName] = token;
      added.push(d.key);
    }
    if (!added.length) return { ok: true, next: 4 }; // skipped / nothing entered
    let matrix = {};
    try {
      matrix = JSON.parse(existing?.eventMatrix || "{}");
    } catch {
      matrix = {};
    }
    for (const key of added) {
      const set = new Set(Array.isArray(matrix[key]) ? matrix[key] : []);
      for (const e of DEFAULT_DEST_EVENTS) set.add(e);
      matrix[key] = [...set];
    }
    settingsUpdate.eventMatrix = JSON.stringify(matrix);
    settingsUpdate.serverSideKeys = writeServerSideKeys(keys);
    await prisma.trackingSettings.update({ where: { shopDomain }, data: settingsUpdate });
    const pixelError = await refreshPixel({ admin, request, shopDomain }); // Meta pixel id now rides the pixel config
    await logActivity(shopDomain, `Setup wizard: added ${added.join(", ")}`);
    return { ok: true, next: 4, pixelError, added };
  }

  // Optional step 4 — subscriptions. App-agnostic: we read Shopify's native selling-plan data, so turning
  // the toggle on is all that's needed. The chosen app is stored for reference/support only.
  if (intent === "connect_subscriptions") {
    const wants = form.get("subscription") === "on";
    let cfg = {};
    try {
      cfg = JSON.parse(existing?.subscriptionConfig || "{}");
    } catch {
      cfg = {};
    }
    const app = (form.get("subscriptionApp") || "").trim() || cfg.app || null;
    const subscriptionConfig = JSON.stringify({
      eventName: cfg.eventName || "subscription_purchase",
      monthDays: cfg.monthDays || 28,
      respectConsent: cfg.respectConsent ?? true,
      app: wants ? app : cfg.app || null,
    });
    await prisma.trackingSettings.update({ where: { shopDomain }, data: { subscriptionTracking: wants, subscriptionConfig } });
    await logActivity(shopDomain, wants ? `Setup wizard: subscription tracking on (${app || "unspecified"})` : "Setup wizard: subscriptions skipped");
    return { ok: true, next: 5, subscriptionOn: wants };
  }

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

// Plain-language destination catalogue for the optional ad-platform step.
const DESTINATIONS = [
  { key: "meta", label: "Meta (Facebook & Instagram)", idLabel: "Meta Pixel ID", idPlaceholder: "1234567890", idHelp: "Meta Events Manager → Data sources → your pixel → the ID shown under its name.", tokenLabel: "Conversions API token", tokenHelp: "Events Manager → your pixel → Settings → Conversions API → Generate access token." },
  { key: "tiktok", label: "TikTok", idLabel: "TikTok Pixel ID", idPlaceholder: "C4XXXXXXXXXXXXXXXX", idHelp: "TikTok Events Manager → your pixel → the pixel ID.", tokenLabel: "Events API access token", tokenHelp: "TikTok Events Manager → your pixel → Settings → Generate access token." },
  { key: "pinterest", label: "Pinterest", idLabel: "Pinterest Tag ID", idPlaceholder: "2612345678901", idHelp: "Pinterest Ads → Conversions → your tag ID.", tokenLabel: "Conversions API token", tokenHelp: "Pinterest Ads → Conversions → Conversions API → generate a token." },
  { key: "snap", label: "Snapchat", idLabel: "Snap Pixel ID", idPlaceholder: "", idHelp: "Snapchat Ads Manager → Events Manager → your pixel ID.", tokenLabel: "Conversions API token", tokenHelp: "Snapchat Events Manager → generate a Conversions API token." },
  { key: "reddit", label: "Reddit", idLabel: "Reddit Pixel ID", idPlaceholder: "a2_abcdef123456", idHelp: "Reddit Ads → Events Manager → your pixel ID.", tokenLabel: "Conversions API token", tokenHelp: "Reddit Ads → Conversions API → generate a token." },
  { key: "linkedin", label: "LinkedIn", idLabel: "Conversion ID", idPlaceholder: "12345678", idHelp: "LinkedIn Campaign Manager → your conversion’s ID.", tokenLabel: "Conversions API token", tokenHelp: "LinkedIn Campaign Manager → Conversions API access token." },
  { key: "bing", label: "Microsoft Ads (Bing)", idLabel: "UET Tag ID", idPlaceholder: "123456789", idHelp: "Microsoft Ads → Conversion tracking → UET tag → the tag ID.", tokenLabel: "Conversions API token", tokenHelp: "Microsoft Ads → offline conversions / CAPI token." },
];

function StepHeader({ step, title }) {
  return (
    <BlockStack gap="200">
      <InlineStack gap="200" blockAlign="center">
        <Badge tone="info">{`Step ${step} of ${TOTAL}`}</Badge>
        <div style={{ flex: 1, minWidth: 120 }}>
          <ProgressBar progress={Math.round(((step - 1) / TOTAL) * 100)} size="small" />
        </div>
      </InlineStack>
      <Text as="h2" variant="headingLg">{title}</Text>
    </BlockStack>
  );
}

function DestinationPicker({ configured }) {
  const [open, setOpen] = useState({});
  const [vals, setVals] = useState({});
  const setVal = (name) => (v) => setVals((s) => ({ ...s, [name]: v }));
  return (
    <BlockStack gap="300">
      {DESTINATIONS.map((d) => {
        const isOpen = open[d.key] ?? false;
        const srv = DEST_SERVER.find((x) => x.key === d.key);
        return (
          <div key={d.key} style={{ borderTop: "1px solid var(--p-color-border-subdued)", paddingTop: "var(--p-space-300)" }}>
            <InlineStack gap="200" blockAlign="center">
              <Checkbox label={d.label} checked={isOpen} onChange={(v) => setOpen((s) => ({ ...s, [d.key]: v }))} />
              {configured[d.key] && <Badge tone="success">Already added</Badge>}
            </InlineStack>
            {/* Fields only render (and therefore only post) when the box is ticked — the real field names the
                action reads are on the inputs directly. */}
            {isOpen && (
              <div style={{ paddingTop: "var(--p-space-200)", paddingLeft: "var(--p-space-600)" }}>
                <BlockStack gap="200">
                  <TextField label={d.idLabel} name={srv.idField} autoComplete="off" value={vals[`${d.key}Id`] || ""} onChange={setVal(`${d.key}Id`)} placeholder={d.idPlaceholder} helpText={d.idHelp} />
                  <TextField label={d.tokenLabel} name={srv.tokenField} type="password" autoComplete="off" value={vals[`${d.key}Token`] || ""} onChange={setVal(`${d.key}Token`)} helpText={configured[d.key] ? `${d.tokenHelp} (leave blank to keep the saved one)` : d.tokenHelp} />
                </BlockStack>
              </div>
            )}
          </div>
        );
      })}
    </BlockStack>
  );
}

export default function Wizard() {
  const { state, shop, configured, restart, savedGa4Id, subscriptionOn, subscriptionApp } = useLoaderData();
  const actionData = useActionData();
  // Client-driven step (so the optional destinations step can be skipped). Seeded from server state; a
  // restart always begins at step 1.
  const [step, setStep] = useState(restart ? 1 : !state.hasGa4 ? 1 : !state.hasSecret ? 2 : 3);
  // Whether setup was ALREADY complete when the wizard opened (a returning merchant) — captured at mount so
  // it doesn't flip mid-flow (a fresh flow makes state.complete true after step 2, but the merchant should
  // still see steps 3-4). A restart bypasses this to force the flow.
  const returningComplete = useRef(state.complete && !restart);
  const flow = useFetcher(); // saves for steps 1-3
  const testFetcher = useFetcher(); // step 4 live test
  const handled = useRef(null);
  const [ga4Id, setGa4Id] = useState(restart ? savedGa4Id : "");
  const [secret, setSecret] = useState("");
  const [subOn, setSubOn] = useState(Boolean(subscriptionOn));
  const [subApp, setSubApp] = useState(subscriptionApp || "shopify");
  const subNote = SUBSCRIPTION_APPS.find((a) => a.value === subApp);

  // Advance once per completed save (fetcher.data is a fresh object per response).
  useEffect(() => {
    if (flow.state === "idle" && flow.data?.next && flow.data !== handled.current) {
      handled.current = flow.data;
      setStep(flow.data.next);
    }
  }, [flow.state, flow.data]);

  const embedUrl = `https://${shop}/admin/themes/current/editor?context=apps`;
  const busy = flow.state !== "idle";
  const err = flow.data?.error || actionData?.error;
  const pixelError = flow.data?.pixelError;

  if (returningComplete.current) {
    return (
      <Page title="Setup" subtitle="Your tracking is live.">
        <Card>
          <BlockStack gap="300">
            <Banner tone="success" title="You're all set">
              GA4 is connected, server-side delivery is on, and the Web Pixel is installed. Your events are
              now being sent.
            </Banner>
            <InlineStack gap="300">
              <Button url="/app/attribution">See your attribution</Button>
              <Button url="/app/accuracy" variant="plain">Check accuracy</Button>
              <Button url="/app/tracking" variant="plain">Fine-tune destinations & events</Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Set up your tracking" subtitle="A few short steps. We'll handle the technical parts for you.">
      <BlockStack gap="400">
        {err && <Banner tone="critical">{err}</Banner>}
        {pixelError && (
          <Banner tone="warning" title="Saved, but the storefront pixel needs a moment">
            {pixelError} — this usually clears on its own; you can carry on.
          </Banner>
        )}

        {step === 1 && (
          <Card>
            <BlockStack gap="400">
              <StepHeader step={1} title="Connect Google Analytics 4" />
              <Text as="p">Paste your Google Analytics Measurement ID. That&apos;s all we need to start — we&apos;ll switch everything else on for you.</Text>
              <flow.Form method="post">
                <input type="hidden" name="intent" value="connect_ga4" />
                <BlockStack gap="300">
                  <TextField label="Google Analytics Measurement ID" name="ga4Id" autoComplete="off" value={ga4Id} onChange={setGa4Id} placeholder="G-XXXXXXXXXX" helpText="Where to find it: in Google Analytics, click Admin (the cog, bottom-left) → Data streams → click your website → the Measurement ID (G-…) is at the top right." />
                  <InlineStack gap="200">
                    <Button submit variant="primary" loading={busy}>Connect and continue</Button>
                    {restart && state.hasGa4 && <Button variant="plain" onClick={() => setStep(2)}>Skip — GA4 already connected</Button>}
                  </InlineStack>
                </BlockStack>
              </flow.Form>
            </BlockStack>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <BlockStack gap="400">
              <StepHeader step={2} title="Add your secret key" />
              <Text as="p">One more value from Google Analytics. This lets us send your sales to GA4 securely from our server, which is what keeps your data flowing past ad blockers and on the checkout.</Text>
              <flow.Form method="post">
                <input type="hidden" name="intent" value="save_secret" />
                <BlockStack gap="300">
                  <TextField label="GA4 Measurement Protocol secret" name="ga4ApiSecret" type="password" autoComplete="off" value={secret} onChange={setSecret} helpText="Where to find it: Google Analytics → Admin → Data streams → click your website → scroll to “Measurement Protocol API secrets” → Create → copy the Secret value here." />
                  <InlineStack gap="200">
                    <Button submit variant="primary" loading={busy}>Save and continue</Button>
                    {restart && state.hasSecret && <Button variant="plain" onClick={() => setStep(3)}>Skip — secret already saved</Button>}
                    <Button variant="plain" onClick={() => setStep(1)}>Back</Button>
                  </InlineStack>
                </BlockStack>
              </flow.Form>
            </BlockStack>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <BlockStack gap="400">
              <StepHeader step={3} title="Track any ad platforms too? (optional)" />
              <Text as="p">
                Pick any advertising platforms you run, and we&apos;ll send your purchases and key events to them
                server-side as well — so their conversion tracking is accurate. Tick the ones you use, paste
                their ID and API token, or skip this and add them later.
              </Text>
              <flow.Form method="post">
                <input type="hidden" name="intent" value="connect_destinations" />
                <DestinationPicker configured={configured} />
                <div style={{ paddingTop: "var(--p-space-400)" }}>
                  <InlineStack gap="200">
                    <Button submit variant="primary" loading={busy}>Save and continue</Button>
                    <Button variant="plain" onClick={() => setStep(4)}>Skip — no ad platforms</Button>
                  </InlineStack>
                </div>
              </flow.Form>
            </BlockStack>
          </Card>
        )}

        {step === 4 && (
          <Card>
            <BlockStack gap="400">
              <StepHeader step={4} title="Do you sell subscriptions? (optional)" />
              <Text as="p">
                Turn this on to get the marketing channel tied to every subscription — both the first sale
                and each renewal — in your reports. Google Analytics can&apos;t do the renewals, because a
                renewal has no website visit for it to read a channel from. Tell us which app you use.
              </Text>
              <flow.Form method="post">
                <input type="hidden" name="intent" value="connect_subscriptions" />
                <input type="hidden" name="subscription" value={subOn ? "on" : ""} />
                <BlockStack gap="300">
                  <Checkbox label="Yes — I sell subscriptions and want renewals tracked" checked={subOn} onChange={setSubOn} />
                  {subOn && (
                    <BlockStack gap="300">
                      <Select
                        label="Which subscription app do you use?"
                        name="subscriptionApp"
                        options={SUBSCRIPTION_APPS.map((a) => ({ label: a.label, value: a.value }))}
                        value={subApp}
                        onChange={setSubApp}
                      />
                      {subNote && <Banner tone={subNote.ok ? "success" : "info"}>{subNote.note}</Banner>}
                      <Text as="p" variant="bodySm" tone="subdued">
                        You&apos;ll see subscription revenue by channel on the Attribution page. Renewals rely
                        on the storefront add-on (next step) to capture the buyer&apos;s Google Analytics
                        session, so make sure that&apos;s switched on.
                      </Text>
                    </BlockStack>
                  )}
                  <InlineStack gap="200">
                    <Button submit variant="primary" loading={busy}>Save and continue</Button>
                    <Button variant="plain" onClick={() => setStep(5)}>Skip — no subscriptions</Button>
                    <Button variant="plain" onClick={() => setStep(3)}>Back</Button>
                  </InlineStack>
                </BlockStack>
              </flow.Form>
            </BlockStack>
          </Card>
        )}

        {step === 5 && (
          <Card>
            <BlockStack gap="400">
              <StepHeader step={5} title="Turn on the storefront add-on, then test" />
              {flow.data?.added?.length ? <Banner tone="success">Added: {flow.data.added.join(", ")}.</Banner> : null}
              <Text as="p">Last thing: switch on the app in your theme so it can track visitors browsing your store.</Text>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">1. Click the button below (it opens your theme editor in a new tab).</Text>
                <Text as="p" variant="bodyMd">2. In the panel that opens, find <b>Pixelify SEO engagement</b> and switch it <b>on</b>.</Text>
                <Text as="p" variant="bodyMd">3. Click <b>Save</b> in the theme editor, then come back here.</Text>
                <InlineStack><Button url={embedUrl} target="_blank" variant="primary">Open my theme editor</Button></InlineStack>
              </BlockStack>
              <Divider />
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Check it&apos;s working</Text>
                <Text as="p">Send a test to Google Analytics to confirm the connection. (This checks the connection, not the theme switch above — that only affects live storefront visitors.)</Text>
                <testFetcher.Form method="post">
                  <input type="hidden" name="intent" value="test" />
                  <InlineStack gap="200" blockAlign="center">
                    <Button submit loading={testFetcher.state !== "idle"}>Send test to GA4</Button>
                    {testFetcher.data?.testOk === true && <Badge tone="success">Passed</Badge>}
                    {testFetcher.data?.testOk === false && <Badge tone="critical">Failed</Badge>}
                  </InlineStack>
                </testFetcher.Form>
                {testFetcher.data?.testDetail && <Text as="p" variant="bodySm" tone={testFetcher.data?.testOk ? "subdued" : "critical"}>{testFetcher.data.testDetail}</Text>}
                <InlineStack gap="300">
                  {testFetcher.data?.testOk && <Button url="/app/attribution" variant="primary">Finish — see your data</Button>}
                  <Button variant="plain" onClick={() => setStep(4)}>Back</Button>
                </InlineStack>
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
