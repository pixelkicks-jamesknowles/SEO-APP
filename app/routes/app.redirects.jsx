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
  Banner,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createRedirect } from "../lib/admin-queries.server";
import { logActivity } from "../lib/activity.server";
import { parseCsvRedirects } from "../lib/csv-redirects.server";
import { SectionHeading } from "../components/SectionHeading";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const logs = await prisma.redirect404Log.findMany({
    where: { shopDomain: session.shop, resolved: false },
    orderBy: { hits: "desc" },
    take: 50,
  });
  let redirects = [];
  try {
    const res = await admin.graphql(
      `#graphql
      query Redirects { urlRedirects(first: 50) { nodes { id path target } } }`,
    );
    const json = await res.json();
    redirects = json.data?.urlRedirects?.nodes ?? [];
  } catch {
    // non-fatal — the manual creator + 404 list still work
  }
  return { logs, redirects };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "importcsv") {
    const rows = parseCsvRedirects(form.get("csv"));
    if (!rows.length) return { error: "No valid 'from,to' rows found in the CSV." };
    let created = 0;
    let lastError = null;
    for (const r of rows) {
      const res = await createRedirect(admin, r.from, r.to);
      if (res.ok) created += 1;
      else lastError = res.error;
    }
    await logActivity(session.shop, "Imported redirects (CSV)", `${created} created`);
    return {
      ok: true,
      created: `${created} redirect(s) imported${lastError ? ` — some failed: ${lastError}` : ""}`,
    };
  }

  const from = (form.get("from") || "").trim();
  const to = (form.get("to") || "").trim();
  if (!from || !to) return { error: "Enter both a path and a target." };

  const result = await createRedirect(admin, from, to);
  if (!result.ok) return { error: result.error };

  if (intent === "from404") {
    const logId = form.get("logId");
    if (logId) {
      await prisma.redirect404Log
        .update({ where: { id: logId }, data: { resolved: true, suggestedTarget: to } })
        .catch(() => {});
    }
  }
  await logActivity(session.shop, "Created redirect", `${from} → ${to}`);
  return { ok: true, created: `${from} → ${to}` };
};

export default function Redirects() {
  const { logs, redirects } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [csv, setCsv] = useState("");

  return (
    <Page title="Redirects" subtitle="Create 301s, resolve logged 404s, and auto-redirect on handle changes.">

      <BlockStack gap="400">
        {actionData?.ok && (
          <Banner tone="success">Created redirect: {actionData.created}</Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Couldn’t create the redirect">
            {actionData.error}
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Create a 301 redirect"
              help="Permanently redirect an old URL to a new one. 301s preserve search rankings and stop visitors hitting dead links."
            />
            <Form method="post">
              <input type="hidden" name="intent" value="manual" />
              <InlineStack gap="300" blockAlign="end" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="From path"
                    name="from"
                    autoComplete="off"
                    value={from}
                    onChange={setFrom}
                    placeholder="/products/old-handle"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Target"
                    name="to"
                    autoComplete="off"
                    value={to}
                    onChange={setTo}
                    placeholder="/products/new-handle"
                  />
                </div>
                <Button submit variant="primary" loading={busy}>
                  Add
                </Button>
              </InlineStack>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title="Bulk import (CSV)"
              help="Paste one redirect per line as from,to (e.g. /old-url,/new-url). Migrating stores often arrive with hundreds."
            />
            <Form method="post">
              <input type="hidden" name="intent" value="importcsv" />
              <BlockStack gap="200">
                <TextField
                  label="CSV"
                  labelHidden
                  multiline={4}
                  autoComplete="off"
                  name="csv"
                  value={csv}
                  onChange={setCsv}
                  placeholder={"/old-handle,/new-handle\n/legacy/page,/pages/about"}
                />
                <Button submit loading={busy}>
                  Import CSV
                </Button>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title={`404s needing a redirect (${logs.length})`}
              help="Storefront URLs that returned 'not found', logged by the app. Add a 301 to send that traffic somewhere useful. Populates once deployed (the proxy beacon doesn't run on localhost)."
            />
            {logs.length === 0 ? (
              <Text as="p" tone="subdued">
                No unresolved 404s logged. Storefront misses appear here once the app proxy beacon is
                live (deployed host).
              </Text>
            ) : (
              <BlockStack gap="200">
                {logs.map((log) => (
                  <div key={log.id}>
                    <Form method="post">
                      <input type="hidden" name="intent" value="from404" />
                      <input type="hidden" name="logId" value={log.id} />
                      <input type="hidden" name="from" value={log.path} />
                      <InlineStack gap="300" blockAlign="end" wrap={false}>
                        <div style={{ flex: 1 }}>
                          <Text as="span" variant="bodyMd">
                            {log.path}
                          </Text>{" "}
                          <Text as="span" tone="subdued" variant="bodySm">
                            ({log.hits} hits)
                          </Text>
                        </div>
                        <div style={{ flex: 1 }}>
                          <TextField
                            label="Target"
                            labelHidden
                            name="to"
                            autoComplete="off"
                            placeholder="/target-path"
                          />
                        </div>
                        <Button submit>Add 301</Button>
                      </InlineStack>
                    </Form>
                    <Divider />
                  </div>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <SectionHeading
              title={`Existing redirects (${redirects.length})`}
              help="Every 301 currently active on the store, including ones auto-created when a product handle changes."
            />
            {redirects.length === 0 ? (
              <Text as="p" tone="subdued">
                None yet.
              </Text>
            ) : (
              <BlockStack gap="100">
                {redirects.map((r) => (
                  <Text as="p" key={r.id} variant="bodyMd">
                    {r.path} → {r.target}
                  </Text>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
