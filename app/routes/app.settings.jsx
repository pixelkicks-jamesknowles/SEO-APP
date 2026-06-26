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
  return { hasGa4Secret: Boolean(keys.ga4ApiSecret), hasCapiToken: Boolean(keys.metaCapiToken) };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
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
};

export default function Settings() {
  const { hasGa4Secret, hasCapiToken } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const [ga4Secret, setGa4Secret] = useState("");
  const [capiToken, setCapiToken] = useState("");

  return (
    <Page title="Settings" subtitle="Server-side delivery credentials.">
      <BlockStack gap="400">
        {actionData?.ok && <Banner tone="success">{actionData.ok}</Banner>}
        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Server-side tracking keys"
              help="Credentials for server-side delivery — the GA4 Measurement Protocol secret (also used by the subscription event) and the Meta CAPI token."
            />
            <Text as="p" tone="subdued">Used by server-side fan-out (GA4 Measurement Protocol + Meta CAPI).</Text>
            <Form method="post">
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
      </BlockStack>
    </Page>
  );
}
