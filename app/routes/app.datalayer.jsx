import { useLoaderData, useActionData, useNavigation, Form } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Banner, Button, Badge, Divider, List, Box } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { requirePro, hasProAccess, PRO_PLAN } from "../lib/billing.server";
import { DATA_LAYER_EVENTS } from "../lib/datalayer";
import { SectionHeading } from "../components/SectionHeading";

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const tracking = await prisma.trackingSettings.findUnique({ where: { shopDomain: session.shop } });
  const pro = await hasProAccess(billing);
  return {
    enabled: Boolean(tracking?.dataLayerEnabled),
    pro, // { active, enforced, plan }
    events: DATA_LAYER_EVENTS,
  };
};

export const action = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const enable = form.get("enabled") === "on";

  // Turning the data layer ON is the Pro gate. requirePro is a no-op while billing is unenforced (the
  // app is free today), and starts requiring an active Pro subscription the moment BILLING_ENFORCED is
  // set — no code change here. Turning it OFF is always allowed (never trap a downgrade).
  if (enable) await requirePro(billing);

  await prisma.trackingSettings.upsert({
    where: { shopDomain },
    create: { shopDomain, dataLayerEnabled: enable },
    update: { dataLayerEnabled: enable },
  });
  return { ok: true, enabled: enable };
};

export default function DataLayer() {
  const { enabled: savedEnabled, pro, events } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const enabled = actionData?.ok ? actionData.enabled : savedEnabled;
  const busy = nav.state !== "idle";

  return (
    <Page
      title="GTM data layer"
      subtitle="Push GA4-standard + Elevar-compatible dl_* ecommerce events to your own Google Tag Manager web container."
    >
      <BlockStack gap="400">
        {pro.enforced && !pro.active && (
          <Banner tone="info" title="This is a Pro feature">
            The GTM data layer is part of {PRO_PLAN}. Turning it on will prompt you to start the subscription.
          </Banner>
        )}
        {actionData?.ok && (
          <Banner tone="success">Data layer {actionData.enabled ? "enabled" : "disabled"}.</Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <SectionHeading
                title="Storefront data layer"
                description="When on, the theme app embed emits the full browse funnel to window.dataLayer on your storefront."
              />
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={enabled ? "success" : undefined}>{enabled ? "On" : "Off"}</Badge>
                {!pro.enforced && <Badge tone="magic">Included (free while in beta)</Badge>}
              </InlineStack>
            </InlineStack>
            <Divider />
            <Text as="p" variant="bodyMd">
              Your GTM <b>web</b> container gets {events.length - 1} browse-funnel events, each fired twice — once in the
              GA4-standard shape (<code>view_item</code>, <code>add_to_cart</code>…) and once as its Elevar-compatible
              mirror (<code>dl_view_item</code>…) — so it works with GTM&rsquo;s built-in GA4 tags and with prebuilt
              Elevar containers alike.
            </Text>
            <List type="bullet">
              {events.filter((e) => e !== "user_data").map((e) => (
                <List.Item key={e}><code>{e}</code> / <code>dl_{e}</code></List.Item>
              ))}
              <List.Item><code>user_data</code> / <code>dl_user_data</code> — logged-in customer properties</List.Item>
            </List>
            <Banner tone="warning">
              <b>Purchase is delivered server-side, not in the page data layer.</b> Shopify&rsquo;s checkout is no longer
              themeable, so no app can push a <code>purchase</code> event to your web container. Pixelify sends the
              purchase conversion straight to GA4 / Meta server-side (deduped &amp; reconciled) — point your GA4
              config to that, or run a server-side GTM container for it.
            </Banner>
            <Form method="post">
              <input type="hidden" name="enabled" value={enabled ? "off" : "on"} />
              <Button submit variant="primary" tone={enabled ? "critical" : undefined} loading={busy}>
                {enabled ? "Turn off data layer" : "Turn on data layer"}
              </Button>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Set it up in Google Tag Manager"
              description="One-time wiring in your own GTM web container."
            />
            <Divider />
            <List type="number">
              <List.Item>Enable the <b>Pixelify SEO engagement</b> app embed (Theme editor → App embeds) — it hosts the data layer script.</List.Item>
              <List.Item>In GTM, confirm your GA4 Configuration tag is installed on the storefront (or add one).</List.Item>
              <List.Item>Create GA4 Event tags triggered on Custom Events <code>view_item</code>, <code>add_to_cart</code>, <code>begin_checkout</code>, etc., reading the <code>ecommerce</code> object — or import a prebuilt GA4 container that listens on the <code>dl_*</code> events.</List.Item>
              <List.Item>Use GTM Preview + the browser console (<code>window.dataLayer</code>) to confirm events fire as you browse, add to cart, and hit checkout.</List.Item>
            </List>
            <Box background="bg-surface-secondary" padding="300" borderRadius="200">
              <Text as="p" variant="bodySm" tone="subdued">
                Events are consent-gated through the storefront&rsquo;s Customer Privacy API and only fire once this
                toggle is on — the storefront reads the live on/off state from the app, so it can&rsquo;t be enabled
                from the theme editor alone.
              </Text>
            </Box>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
