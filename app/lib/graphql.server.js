// admin.graphql wrapper that retries on Shopify GraphQL throttling (exponential backoff).
// Returns the parsed JSON (caller still inspects json.errors / userErrors).
export async function gql(admin, query, variables, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await admin.graphql(query, variables ? { variables } : undefined);
    const json = await res.json();
    const throttled = (json.errors || []).some(
      (e) => e?.extensions?.code === "THROTTLED" || /throttl/i.test(e?.message || ""),
    );
    if (!throttled || attempt >= retries) return json;
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
}
