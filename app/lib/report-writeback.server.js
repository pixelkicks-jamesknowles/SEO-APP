// Attribution write-back → native Shopify reporting.
//
// Shopify's Analytics/ShopifyQL runs against a closed warehouse: there's no app API to add a data source or
// push charts. The ONE supported surface is writing our resolved attribution onto native objects as
// METAFIELDS. Once a metafield DEFINITION exists, that field becomes a first-class column in the report
// builder and a usable trait in customer segments — so this turns "which channel actually acquired this
// order" (which we resolve even where Shopify lost it) into something the merchant can group by inside their
// own admin, without exporting anything.
//
// This module is IO-light and defensive: the pure value/definition specs are unit-tested; the GraphQL calls
// are best-effort (a failure never bubbles to the webhook — the order still tracks, it just isn't stamped).
import { numericId } from "./server-side.server";
import { channelGroupOf } from "./attribution-report";
import { orderTypeOf, customerTypeOf } from "./subscription";

const NS = "connect_analytics";

// Single source of truth for the ORDER metafields: same list drives the definition provisioner (so the
// fields are report-visible) AND the value write (so nothing drifts). `pick` maps our resolved attribution
// object → the metafield's string value; a null/empty pick is skipped (we never write blanks).
export const ORDER_DEFS = [
  { key: "source", name: "Acquisition source", type: "single_line_text_field", pick: (a) => a.source },
  { key: "medium", name: "Acquisition medium", type: "single_line_text_field", pick: (a) => a.medium },
  { key: "source_medium", name: "Source / medium", type: "single_line_text_field", pick: (a) => a.sourceMedium },
  { key: "channel", name: "Acquisition channel", type: "single_line_text_field", pick: (a) => a.channel },
  { key: "campaign", name: "Acquisition campaign", type: "single_line_text_field", pick: (a) => a.campaign },
  { key: "order_type", name: "Order type", type: "single_line_text_field", pick: (a) => a.orderType },
  { key: "customer_type", name: "Customer type", type: "single_line_text_field", pick: (a) => a.customerType },
  { key: "acquisition_date", name: "Acquisition date", type: "date", pick: (a) => a.acquisitionDate },
];

// Customer-level traits (drive native customer SEGMENTS + Marketing/Flow). Needs the write_customers scope;
// the writer no-ops cleanly if it isn't granted (the GraphQL call just userErrors and we swallow it).
export const CUSTOMER_DEFS = [
  { key: "acquisition_channel", name: "Acquisition channel", type: "single_line_text_field", pick: (a) => a.channel },
  { key: "acquisition_source_medium", name: "Acquisition source / medium", type: "single_line_text_field", pick: (a) => a.sourceMedium },
  { key: "acquisition_campaign", name: "Acquisition campaign", type: "single_line_text_field", pick: (a) => a.campaign },
  { key: "acquisition_date", name: "Acquisition date", type: "date", pick: (a) => a.acquisitionDate },
];

/** Derive the full attribution value object from the raw pieces we resolve on orders/paid. Pure.
 *  source/medium are the first-touch pair; channel is derived; sourceMedium is the GA4-style pairing. */
export function attributionValues({ source, medium, campaign, orderType, customerType, acquisitionDate } = {}) {
  const src = source || null;
  const med = medium || null;
  return {
    source: src,
    medium: med,
    sourceMedium: src || med ? `${src || "(direct)"} / ${med || "(none)"}` : null,
    channel: src || med ? channelGroupOf(src, med) : null,
    campaign: campaign || null,
    orderType: orderType || null,
    customerType: customerType || null,
    // Shopify `date` metafields want YYYY-MM-DD. Accept a Date or an ISO string; null → skipped.
    acquisitionDate: acquisitionDate ? new Date(acquisitionDate).toISOString().slice(0, 10) : null,
  };
}

/** Build the metafieldsSet input array for a given owner GID from a defs list + values. Pure. Skips
 *  null/empty values so we never overwrite a real value with a blank. */
export function buildMetafields(ownerId, defs, values) {
  const out = [];
  for (const def of defs) {
    const v = def.pick(values);
    if (v == null || v === "") continue;
    out.push({ ownerId, namespace: NS, key: def.key, type: def.type, value: String(v) });
  }
  return out;
}

const SET_MUTATION = `#graphql
  mutation ConnectAnalyticsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

const DEF_MUTATION = `#graphql
  mutation ConnectAnalyticsDef($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }`;

/** metafieldsSet accepts up to 25 metafields/call; our specs are well under, so one call per owner. */
async function setMetafields(admin, metafields) {
  if (!metafields.length) return { ok: true, skipped: true };
  const res = await admin.graphql(SET_MUTATION, { variables: { metafields } });
  const body = await res.json().catch(() => ({}));
  // Top-level GraphQL errors (throttling, a missing write_orders scope) come back as `errors` with null
  // data — surface them as not-ok + a throttled flag so a bulk caller can back off instead of treating a
  // no-op as success (which would let a backfill advance past orders it never actually wrote).
  const top = body?.errors;
  if (Array.isArray(top) && top.length) {
    const throttled = top.some((e) => /throttl/i.test(e?.message || "") || e?.extensions?.code === "THROTTLED");
    return { ok: false, throttled, errors: top };
  }
  const errs = body?.data?.metafieldsSet?.userErrors || [];
  if (errs.length) return { ok: false, errors: errs };
  return { ok: true };
}

/** Write order attribution metafields. `admin` is an Admin GraphQL client; `orderId` any Shopify order id
 *  form. Best-effort — returns {ok} but never throws for a routine userError. */
export async function writeOrderAttribution(admin, orderId, values) {
  const id = numericId(orderId);
  if (!id) return { ok: false, skipped: true };
  const metafields = buildMetafields(`gid://shopify/Order/${id}`, ORDER_DEFS, values);
  return setMetafields(admin, metafields);
}

/** Write customer acquisition traits (needs write_customers; no-ops cleanly without it). */
export async function writeCustomerAttribution(admin, customerId, values) {
  const id = numericId(customerId);
  if (!id) return { ok: false, skipped: true };
  const metafields = buildMetafields(`gid://shopify/Customer/${id}`, CUSTOMER_DEFS, values);
  return setMetafields(admin, metafields);
}

/**
 * Create the metafield definitions so the fields show as columns/filters in the native report builder and
 * as customer-segment traits (without a definition the values still store, but stay hidden from reports).
 * Idempotent: a "definition already exists" (TAKEN) userError is expected and swallowed. Whole thing is
 * best-effort — if the API rejects the input shape on some version, values still write, so we log and move
 * on rather than let provisioning break the feature.
 */
export async function provisionDefinitions(admin) {
  const plan = [
    ...ORDER_DEFS.map((d) => ({ ...d, ownerType: "ORDER" })),
    ...CUSTOMER_DEFS.map((d) => ({ ...d, ownerType: "CUSTOMER" })),
  ];
  let created = 0;
  for (const d of plan) {
    try {
      const res = await admin.graphql(DEF_MUTATION, {
        variables: {
          definition: {
            namespace: NS,
            key: d.key,
            name: d.name,
            type: d.type,
            ownerType: d.ownerType,
            access: { admin: "MERCHANT_READ" },
            pin: true,
          },
        },
      });
      const body = await res.json().catch(() => ({}));
      if (body?.data?.metafieldDefinitionCreate?.createdDefinition?.id) created++;
    } catch (e) {
      console.warn("[report-writeback] definition:", d.ownerType, d.key, e?.message || e);
    }
  }
  return { created };
}

const CLASSIFY_QUERY = `#graphql
  query ConnectAnalyticsClassify($id: ID!) {
    order(id: $id) {
      tags
      customAttributes { key value }
      customer { numberOfOrders }
      lineItems(first: 50) { nodes { sellingPlan { name } } }
    }
  }`;

/**
 * Best-effort order classification via the Admin API, for paths that only have the client-side pixel event
 * (which carries no orders_count / selling-plan data). Returns { orderType, customerType } or {} on any
 * failure. Maps the GraphQL order onto the REST-ish shape the pure classifiers already consume, so there's
 * one classification code path. `orders_count === 1 → new`, and a new customer's unmarked subscription
 * order is treated as the checkout (not a renewal).
 */
export async function classifyOrderViaAdmin(shopDomain, orderId) {
  const id = numericId(orderId);
  if (!id) return {};
  try {
    // Dynamic import so this module can be pulled into the ingest graph without initializing the Shopify
    // SDK at load time (the backfill does the same). Keeps report-writeback importable in unit tests.
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shopDomain);
    const res = await admin.graphql(CLASSIFY_QUERY, { variables: { id: `gid://shopify/Order/${id}` } });
    const body = await res.json().catch(() => ({}));
    const o = body?.data?.order;
    if (!o) return {};
    const ordersCount = Number(o.customer?.numberOfOrders);
    const order = {
      tags: Array.isArray(o.tags) ? o.tags.join(",") : o.tags || "",
      note_attributes: (o.customAttributes || []).map((a) => ({ name: a.key, value: a.value })),
      customer: Number.isFinite(ordersCount) ? { orders_count: ordersCount } : undefined,
      line_items: (o.lineItems?.nodes || []).map((n) => ({ sellingPlan: n.sellingPlan || null })),
    };
    const isFirstOrder = Number.isFinite(ordersCount) ? ordersCount === 1 : undefined;
    return {
      orderType: orderTypeOf(order, { isFirstSubscriptionOrder: isFirstOrder }),
      customerType: customerTypeOf(order, { isFirstOrder }),
    };
  } catch (e) {
    console.warn("[report-writeback] classify:", e?.message || e);
    return {};
  }
}
