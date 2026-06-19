import { useState } from "react";
import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Badge,
  Banner,
  ProgressBar,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runAudit } from "../lib/audit.server";
import { validateUrl } from "../lib/validate.server";
import { SectionHeading } from "../components/SectionHeading";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const audit = await runAudit(admin);
  const history = await prisma.auditSnapshot.findMany({
    where: { shopDomain: session.shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return { ...audit, shop: session.shop, history: history.map((h) => h.score) };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const url = (await request.formData()).get("url");
  if (!url) return { validate: { error: "Enter a URL to validate." } };
  return { validate: await validateUrl(url) };
};

export default function Audit() {
  const result = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const [url, setUrl] = useState(`https://${result.shop || ""}/`);

  if (result.error) {
    return (
      <Page title="SEO audit">
        <Banner tone="critical" title="Audit failed">
          {result.error}
        </Banner>
      </Page>
    );
  }

  const scoreTone =
    result.score >= 80 ? "success" : result.score >= 50 ? "primary" : "critical";
  const badgeTone =
    result.score >= 80 ? "success" : result.score >= 50 ? "attention" : "critical";
  const active = result.issues.filter((i) => i.count > 0);

  return (
    <Page title="SEO audit" subtitle={`Scanned ${result.scanned} products`}>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <SectionHeading
                title="SEO score"
                help="A 0–100 score from deterministic checks across your products — missing or over-length titles and descriptions, and missing image alt text."
              />
              <Badge tone={badgeTone} size="large">{`${result.score} / 100`}</Badge>
            </InlineStack>
            <ProgressBar progress={result.score} tone={scoreTone} />
            {result.truncated && (
              <Text as="p" tone="subdued" variant="bodySm">
                Score is from a sample of the first {result.scanned} products.
              </Text>
            )}
          </BlockStack>
        </Card>

        {result.history && result.history.length > 1 && (
          <Card>
            <BlockStack gap="200">
              <SectionHeading
                title="Score history"
                help="Recent scores recorded by scheduled monitoring (enable it in Settings) — most recent on the right."
              />
              <InlineStack gap="200" blockAlign="center">
                {result.history
                  .slice()
                  .reverse()
                  .map((score, i) => (
                    <Badge
                      key={i}
                      tone={score >= 80 ? "success" : score >= 50 ? "attention" : "critical"}
                    >
                      {String(score)}
                    </Badge>
                  ))}
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">
                Most recent on the right — populated by scheduled monitoring (Settings).
              </Text>
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Issues"
              help="Each check that failed, with a count and a few sample products so you know where to fix."
            />
            {active.length === 0 ? (
              <Text as="p" tone="subdued">
                No issues found across the scanned products. 🎉
              </Text>
            ) : (
              active.map((i) => (
                <BlockStack gap="100" key={i.key}>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span" variant="bodyMd">
                      {i.label}
                    </Text>
                    <Badge tone="attention">{String(i.count)}</Badge>
                  </InlineStack>
                  {i.samples.length > 0 && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      e.g. {i.samples.join(", ")}
                    </Text>
                  )}
                </BlockStack>
              ))
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Validate structured data"
              help="Fetch a live URL and check its JSON-LD against Google's rich-result requirements, flagging missing required fields."
            />
            <Text as="p" tone="subdued">
              Fetch a live URL and check its JSON-LD against rich-result requirements.
            </Text>
            <Form method="post">
              <InlineStack gap="300" blockAlign="end" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="URL"
                    labelHidden
                    name="url"
                    autoComplete="off"
                    value={url}
                    onChange={setUrl}
                    placeholder="https://your-store.com/products/handle"
                  />
                </div>
                <Button submit loading={nav.state === "submitting"}>
                  Validate
                </Button>
              </InlineStack>
            </Form>
            {actionData?.validate?.error && (
              <Banner tone="warning">{actionData.validate.error}</Banner>
            )}
            {actionData?.validate && !actionData.validate.error && (
              actionData.validate.found === 0 ? (
                <Text as="p" tone="subdued">
                  No JSON-LD found on that page.
                </Text>
              ) : (
                actionData.validate.results.map((r, idx) => (
                  <InlineStack key={idx} align="space-between" blockAlign="center">
                    <Text as="span" variant="bodyMd">
                      {r.type}
                    </Text>
                    {r.valid ? (
                      <Badge tone="success">Valid</Badge>
                    ) : (
                      <Badge tone="critical">{`Missing: ${r.missing.join(", ")}`}</Badge>
                    )}
                  </InlineStack>
                ))
              )
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Internal-linking opportunities"
              help="Products sharing a type that should cross-link to pass authority and help shoppers (and crawlers) discover related items."
            />
            <Text as="p" tone="subdued">
              Products sharing a type that should cross-link to pass authority and aid discovery.
            </Text>
            {result.linkGroups && result.linkGroups.length > 0 ? (
              result.linkGroups.map((g) => (
                <BlockStack gap="050" key={g.type}>
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span" variant="bodyMd">
                      {g.type}
                    </Text>
                    <Badge>{`${g.count} products`}</Badge>
                  </InlineStack>
                  <Text as="span" tone="subdued" variant="bodySm">
                    {g.samples.join(", ")}
                  </Text>
                </BlockStack>
              ))
            ) : (
              <Text as="p" tone="subdued">
                No groups found — products need a product type to suggest links.
              </Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
