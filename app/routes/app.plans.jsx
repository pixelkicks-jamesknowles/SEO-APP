import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Button,
  Badge,
  Banner,
  List,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { PLAN } from "../lib/plans";

const TIERS = [
  {
    key: PLAN.STARTER,
    price: "$15 / mo",
    features: ["Meta templates (title + description)", "Schema + dedup", "Redirects + 404 manager"],
  },
  {
    key: PLAN.GROWTH,
    price: "$39 / mo",
    features: ["Everything in Starter", "Full audit + Core Web Vitals", "llms.txt", "Consent mode"],
  },
  {
    key: PLAN.PRO,
    price: "$79 / mo",
    features: [
      "Everything in Growth",
      "Server-side tracking (Meta CAPI / GA4 MP)",
      "Programmatic pages",
      "Agency multi-store",
    ],
  },
];

export const loader = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  let active = null;
  try {
    const check = await billing.check({ plans: Object.values(PLAN), isTest: true });
    if (check.hasActivePayment) active = check.appSubscriptions?.[0]?.name ?? null;
  } catch {
    // Billing not configured (managed pricing) or no subscription — show all as available.
  }
  return { active };
};

export const action = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  const plan = (await request.formData()).get("plan");
  try {
    // On success this throws a redirect Response to Shopify's confirmation page.
    await billing.request({
      plan,
      isTest: true,
      returnUrl: `${process.env.SHOPIFY_APP_URL}/app/plans`,
    });
    return null;
  } catch (e) {
    if (e instanceof Response) throw e; // success path is a redirect — let it through
    // Billing needs app-managed pricing configured on Partners + a deployed (non-localhost) host.
    return {
      error:
        "Billing isn’t enabled in this environment yet — it needs app-managed pricing on the Partner dashboard and a deployed host (not localhost). Plans are display-only in dev.",
    };
  }
};

export default function Plans() {
  const { active } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  return (
    <Page title="Plans" subtitle="Server-side tracking, programmatic pages, and agency tools unlock on Pro.">

      <BlockStack gap="400">
        {actionData?.error && <Banner tone="warning">{actionData.error}</Banner>}
        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
        {TIERS.map((t) => (
          <Card key={t.key}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  {t.key}
                </Text>
                {active === t.key && <Badge tone="success">Current</Badge>}
              </InlineStack>
              <Text as="p" variant="headingLg">
                {t.price}
              </Text>
              <List>
                {t.features.map((f) => (
                  <List.Item key={f}>{f}</List.Item>
                ))}
              </List>
              <Form method="post">
                <input type="hidden" name="plan" value={t.key} />
                <Button submit variant="primary" disabled={active === t.key} loading={busy}>
                  {active === t.key ? "Current plan" : "Choose"}
                </Button>
              </Form>
            </BlockStack>
          </Card>
        ))}
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
