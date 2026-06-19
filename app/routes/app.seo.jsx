import { useState, useEffect } from "react";
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
  Divider,
  InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logActivity } from "../lib/activity.server";
import { gql } from "../lib/graphql.server";
import { SectionHeading } from "../components/SectionHeading";

const SCHEMA_NODES = ["product", "breadcrumb", "organization", "faq", "video", "article"];

// Insertable template variables (click to add to the focused field).
const VARIABLES = [
  "{{ product.title }}",
  "{{ product.type }}",
  "{{ product.vendor }}",
  "{{ shop.name }}",
  "{{ variant }}",
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const s = await prisma.seoSettings.findUnique({
    where: { shopDomain: session.shop },
  });
  return {
    metaTemplates: JSON.parse(s?.metaTemplates ?? "{}"),
    altTemplate: s?.altTemplate ?? "",
    schemaToggles: JSON.parse(s?.schemaToggles ?? "{}"),
    llmsTxtEnabled: s?.llmsTxtEnabled ?? false,
    autoApply: s?.autoApply ?? false,
  };
};

const PRODUCTS_QUERY = `#graphql
  query SeoProducts($cursor: String) {
    shop { name }
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id title productType vendor }
    }
  }`;

const PRODUCT_SEO_UPDATE = `#graphql
  mutation SetProductSeo($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      userErrors { field message }
    }
  }`;

const COLLECTIONS_QUERY = `#graphql
  query SeoCollections {
    shop { name }
    collections(first: 100) { nodes { id title } }
  }`;

const COLLECTION_SEO_UPDATE = `#graphql
  mutation SetCollectionSeo($input: CollectionInput!) {
    collectionUpdate(input: $input) { userErrors { field message } }
  }`;

// Deterministic {{ var }} substitution — no AI. Unknown tokens render empty.
function renderTemplate(tpl, ctx) {
  if (!tpl) return "";
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => ctx[k] ?? "").replace(/\s+/g, " ").trim();
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  // Apply the SAVED product templates (title + description) across the catalog. To stay within
  // request limits we process a bounded run per click and return a cursor to resume from; the UI
  // re-submits until done. (A full-catalog one-shot belongs in a Bulk Operation / background job.)
  if (intent === "apply") {
    const s = await prisma.seoSettings.findUnique({ where: { shopDomain } });
    const tpls = JSON.parse(s?.metaTemplates ?? "{}");
    if (!tpls.product && !tpls.productDescription) {
      return { applyError: "Set a product title or description template and Save first." };
    }

    const PAGES_PER_RUN = 2; // up to 2 × 50 = 100 products per click
    let cursor = form.get("cursor") || null;
    let shopName = "";
    let applied = 0;
    let lastError = null;
    let hasMore = false;

    for (let page = 0; page < PAGES_PER_RUN; page++) {
      const json = await gql(admin, PRODUCTS_QUERY, { cursor });
      if (json.errors) return { applyError: json.errors.map((e) => e.message).join("; ") };
      const conn = json.data?.products;
      shopName = json.data?.shop?.name ?? shopName;
      for (const p of conn?.nodes ?? []) {
        const ctx = {
          "product.title": p.title,
          "product.type": p.productType,
          "product.vendor": p.vendor,
          "shop.name": shopName,
        };
        const seo = {};
        const title = renderTemplate(tpls.product, ctx);
        const description = renderTemplate(tpls.productDescription, ctx);
        if (title) seo.title = title;
        if (description) seo.description = description;
        if (!Object.keys(seo).length) continue;
        const j = await gql(admin, PRODUCT_SEO_UPDATE, { product: { id: p.id, seo } });
        const errs = j.errors ?? j.data?.productUpdate?.userErrors ?? [];
        if (errs.length) lastError = errs.map((e) => e.message).join("; ");
        else applied += 1;
      }
      cursor = conn?.pageInfo?.endCursor ?? null;
      hasMore = Boolean(conn?.pageInfo?.hasNextPage);
      if (!hasMore) break;
    }
    if (!lastError) await logActivity(shopDomain, "Applied SEO to products", `${applied} this run`);
    return { applied, more: hasMore, nextCursor: hasMore ? cursor : "", applyError: lastError };
  }

  // Apply the saved collection title template to collections' seo.title.
  if (intent === "applycollections") {
    const s = await prisma.seoSettings.findUnique({ where: { shopDomain } });
    const tpl = JSON.parse(s?.metaTemplates ?? "{}").collection;
    if (!tpl) return { applyError: "Set a collection title template and Save first." };
    const json = await gql(admin, COLLECTIONS_QUERY);
    if (json.errors) return { applyError: json.errors.map((e) => e.message).join("; ") };
    const shopName = json.data?.shop?.name ?? "";
    let applied = 0;
    let lastError = null;
    for (const c of json.data?.collections?.nodes ?? []) {
      const title = renderTemplate(tpl, { "collection.title": c.title, "shop.name": shopName });
      if (!title) continue;
      const j = await gql(admin, COLLECTION_SEO_UPDATE, { input: { id: c.id, seo: { title } } });
      const errs = j.errors ?? j.data?.collectionUpdate?.userErrors ?? [];
      if (errs.length) lastError = errs.map((e) => e.message).join("; ");
      else applied += 1;
    }
    if (!lastError) await logActivity(shopDomain, "Applied SEO to collections", `${applied}`);
    return { collectionsApplied: applied, applyError: lastError };
  }

  // intent === "save"
  const metaTemplates = {
    product: form.get("tpl_product") || "",
    productDescription: form.get("tpl_product_desc") || "",
    collection: form.get("tpl_collection") || "",
    page: form.get("tpl_page") || "",
  };
  const schemaToggles = Object.fromEntries(
    SCHEMA_NODES.map((n) => [n, form.get(`schema_${n}`) === "on"]),
  );
  const data = {
    metaTemplates: JSON.stringify(metaTemplates),
    altTemplate: form.get("altTemplate") || null,
    schemaToggles: JSON.stringify(schemaToggles),
    llmsTxtEnabled: form.get("llmsTxtEnabled") === "on",
    autoApply: form.get("autoApply") === "on",
  };
  await prisma.seoSettings.upsert({
    where: { shopDomain },
    create: { shopDomain, ...data },
    update: data,
  });
  await logActivity(shopDomain, "Saved SEO settings");
  return { ok: true };
};

export default function Seo() {
  const data = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const submittingIntent = nav.formData?.get("intent");
  const [toggles, setToggles] = useState(data.schemaToggles);
  const [llms, setLlms] = useState(data.llmsTxtEnabled);
  const [autoApply, setAutoApply] = useState(data.autoApply);
  const [tpl, setTpl] = useState({
    product: data.metaTemplates.product || "",
    productDescription: data.metaTemplates.productDescription || "",
    collection: data.metaTemplates.collection || "",
    page: data.metaTemplates.page || "",
    alt: data.altTemplate || "",
  });
  const setTplField = (k) => (v) => setTpl((s) => ({ ...s, [k]: v }));
  // Resume cursor for catalog-wide Apply (server returns nextCursor each run).
  const [cursor, setCursor] = useState("");
  useEffect(() => {
    if (actionData && "nextCursor" in actionData) setCursor(actionData.nextCursor || "");
  }, [actionData]);

  // Which template field a variable chip inserts into (the last-focused one).
  const [focused, setFocused] = useState("product");
  const insertVar = (token) =>
    setTpl((s) => {
      const cur = s[focused] || "";
      const sep = cur && !cur.endsWith(" ") ? " " : "";
      return { ...s, [focused]: cur + sep + token };
    });

  return (
    <Page title="SEO" subtitle="Deterministic meta templates, validated JSON-LD, and bulk apply — no AI.">

      <Form method="post">
        <BlockStack gap="400">
          {actionData?.ok && <Banner tone="success">Saved.</Banner>}
          {actionData?.applied !== undefined && !actionData?.applyError && (
            <Banner tone="success">
              Applied SEO to {actionData.applied} product(s)
              {actionData.more
                ? " — more remain; click Apply again to continue where it left off."
                : " — catalog complete."}
            </Banner>
          )}
          {actionData?.applyError && (
            <Banner tone="warning" title="Couldn’t apply titles">
              {actionData.applyError}
            </Banner>
          )}
          {actionData?.collectionsApplied !== undefined && !actionData?.applyError && (
            <Banner tone="success">
              Applied titles to {actionData.collectionsApplied} collection(s).
            </Banner>
          )}
          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Meta templates"
                help="Templates that fill each page's SEO title and meta description from product and shop fields. Apply writes them to your products' native SEO fields — no AI."
              />
              <Text as="p" tone="subdued">
                Deterministic — click a variable to insert it into the focused field. No AI.
              </Text>
              <InlineStack gap="150">
                {VARIABLES.map((v) => (
                  <Button key={v} size="slim" onClick={() => insertVar(v)}>
                    {v}
                  </Button>
                ))}
              </InlineStack>
              <TextField
                label="Product title"
                name="tpl_product"
                autoComplete="off"
                value={tpl.product}
                onChange={setTplField("product")}
                onFocus={() => setFocused("product")}
                placeholder="{{ product.title }} — {{ product.type }} | {{ shop.name }}"
              />
              <TextField
                label="Product meta description"
                name="tpl_product_desc"
                autoComplete="off"
                multiline={2}
                value={tpl.productDescription}
                onChange={setTplField("productDescription")}
                onFocus={() => setFocused("productDescription")}
                placeholder="{{ product.title }} by {{ product.vendor }} — shop {{ product.type }} at {{ shop.name }}."
              />
              <TextField
                label="Collection title"
                name="tpl_collection"
                autoComplete="off"
                value={tpl.collection}
                onChange={setTplField("collection")}
                onFocus={() => setFocused("collection")}
              />
              <TextField
                label="Page title"
                name="tpl_page"
                autoComplete="off"
                value={tpl.page}
                onChange={setTplField("page")}
                onFocus={() => setFocused("page")}
              />
              <Divider />
              <TextField
                label="Image alt text template"
                name="altTemplate"
                autoComplete="off"
                value={tpl.alt}
                onChange={setTplField("alt")}
                onFocus={() => setFocused("alt")}
                placeholder="{{ product.title }} – {{ variant }}"
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Structured data (JSON-LD)"
                help="JSON-LD the storefront app embed adds so Google can show rich results (price, ratings, breadcrumbs, FAQ). The dedup pass suppresses any node the theme already outputs, so you never get duplicate schema."
              />
              <Text as="p" tone="subdued">
                Emitted by the storefront app embed. The dedup pass suppresses any node the
                theme already outputs (single-emitter rule).
              </Text>
              {SCHEMA_NODES.map((n) => (
                <Checkbox
                  key={n}
                  label={n}
                  name={`schema_${n}`}
                  checked={!!toggles[n]}
                  onChange={(v) => setToggles((t) => ({ ...t, [n]: v }))}
                />
              ))}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Answer-engine readiness"
                help="Serves a deterministic /llms.txt export of your catalog so AI answer engines (ChatGPT, Perplexity, etc.) can read your store. It's a structured export — no content is generated."
              />
              <Checkbox
                label="Serve /llms.txt (deterministic catalog export — no content generation)"
                name="llmsTxtEnabled"
                checked={llms}
                onChange={setLlms}
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <SectionHeading
                title="Automation"
                help="When on, every newly-created product automatically gets its SEO title and description from the templates above — no need to run Apply manually."
              />
              <Checkbox
                label="Auto-apply templates to new products on create"
                helpText="When a product is created, set its SEO title + description from the templates above."
                name="autoApply"
                checked={autoApply}
                onChange={setAutoApply}
              />
            </BlockStack>
          </Card>

          <input type="hidden" name="cursor" value={cursor} />
          <InlineStack gap="300" blockAlign="center">
            <Button
              submit
              name="intent"
              value="save"
              variant="primary"
              loading={saving && submittingIntent === "save"}
            >
              Save
            </Button>
            <Button
              submit
              name="intent"
              value="apply"
              loading={saving && submittingIntent === "apply"}
            >
              {cursor ? "Apply — continue" : "Apply to products"}
            </Button>
            <Button
              submit
              name="intent"
              value="applycollections"
              loading={saving && submittingIntent === "applycollections"}
            >
              Apply to collections
            </Button>
            <Text as="span" tone="subdued" variant="bodySm">
              Writes title + description from the last saved templates (~100 products per click).
            </Text>
          </InlineStack>
        </BlockStack>
      </Form>
    </Page>
  );
}
