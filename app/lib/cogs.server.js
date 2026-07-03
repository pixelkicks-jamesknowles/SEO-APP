// True-profit (COGS) valuation. When valueMode = "cogs" the conversion `value` sent to ad platforms is
// the order's PROFIT (revenue − cost of goods) instead of raw revenue, so smart-bidding optimises for
// margin, not top-line. Cost comes from Shopify's native "Cost per item" (ProductVariant →
// InventoryItem.unitCost), fetched via the Admin API for the purchase's variants and cached briefly.
//
// Best-effort by design: if a cost can't be resolved the value falls back to raw revenue (withValueMode
// no-ops), so a lookup failure NEVER zeroes or blocks a conversion. Only runs on checkout_completed
// (low volume), so the extra Admin call is off the page-view hot path. shopify.server is imported
// dynamically so this module's pure helpers stay unit-testable without pulling the app instance in.

const numId = (gid) => (gid == null ? null : String(gid).match(/\d+/g)?.pop() || null);

const VARIANT_COST_QUERY = `#graphql
  query VariantCosts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant { id inventoryItem { unitCost { amount } } }
    }
  }`;

// Per-process cost cache (shop|variantId → { amount, at }). A store sells the same variants repeatedly,
// so caching avoids an Admin fetch per purchase for already-seen variants. The TTL keeps it fresh after
// a merchant edits a cost. Bounded by the distinct variants sold within the window.
const COST_TTL_MS = 60 * 60 * 1000; // 1h
const costCache = new Map();

/** Test seam: clear the cost cache between cases. */
export function __resetCogsCache() {
  costCache.clear();
}

export function cogsEnabled(settings) {
  return settings?.valueMode === "cogs";
}

/** { variantId (numeric), quantity } for each line of a normalized checkout event. Pure. */
export function checkoutLineVariants(event) {
  const lines = event?.data?.checkout?.lineItems || [];
  return lines
    .map((li) => ({ variantId: numId(li?.variant?.id), quantity: Math.max(1, Number(li?.quantity) || 1) }))
    .filter((l) => l.variantId);
}

/** Total cost of goods for a checkout event given a Map(numericVariantId → unitCost). Returns null when
 *  NO line's cost resolved — so the caller keeps revenue rather than reporting the whole order as pure
 *  profit off a partial/empty cost map. Pure. */
export function orderCost(event, costMap) {
  let total = 0;
  let any = false;
  for (const { variantId, quantity } of checkoutLineVariants(event)) {
    const c = costMap?.get?.(variantId);
    if (c != null && Number.isFinite(Number(c))) {
      total += Number(c) * quantity;
      any = true;
    }
  }
  return any ? Math.round(total * 100) / 100 : null;
}

/** Fetch unit costs for numeric variant ids (cache first, then one Admin GraphQL call for the misses).
 *  Returns Map(numericVariantId → unitCost). Missing/failed lookups are simply absent. Best-effort. */
export async function fetchVariantCosts(shop, variantIds, { admin } = {}) {
  const ids = [...new Set((variantIds || []).map(numId).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const now = Date.now();
  const missing = [];
  for (const id of ids) {
    const hit = costCache.get(`${shop}|${id}`);
    if (hit && now - hit.at < COST_TTL_MS) {
      if (hit.amount != null) out.set(id, hit.amount);
    } else missing.push(id);
  }
  if (!missing.length) return out;
  try {
    let client = admin;
    if (!client) {
      const { unauthenticated } = await import("../shopify.server");
      ({ admin: client } = await unauthenticated.admin(shop));
    }
    const res = await client.graphql(VARIANT_COST_QUERY, { variables: { ids: missing.map((id) => `gid://shopify/ProductVariant/${id}`) } });
    const json = await res.json();
    for (const node of json?.data?.nodes || []) {
      const id = numId(node?.id);
      if (!id) continue;
      const raw = node?.inventoryItem?.unitCost?.amount;
      const amount = raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null;
      // Cache the miss too (amount:null) so a variant with no cost set doesn't refetch every purchase.
      costCache.set(`${shop}|${id}`, { amount, at: now });
      if (amount != null) out.set(id, amount);
    }
  } catch (e) {
    // Surface but never throw — cogs valuation degrades to revenue rather than breaking delivery.
    console.warn("[cogs] variant cost lookup failed:", e?.message || e);
  }
  return out;
}

/** Resolve an order's total COGS for a normalized checkout event (fetches then sums). Returns null when
 *  no cost could be resolved → caller keeps revenue. `admin` may be passed to reuse an open client. */
export async function resolveOrderCost(shop, event, { admin } = {}) {
  const lines = checkoutLineVariants(event);
  if (!lines.length) return null;
  const costMap = await fetchVariantCosts(shop, lines.map((l) => l.variantId), { admin });
  return orderCost(event, costMap);
}
