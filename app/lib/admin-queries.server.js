// Shared Admin API helpers used by routes + webhooks.

const CREATE_REDIRECT = `#graphql
  mutation CreateRedirect($redirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $redirect) {
      urlRedirect { id path target }
      userErrors { field message }
    }
  }`;

// Create a 301 from `path` → `target`. Returns { ok, error, redirect }.
export async function createRedirect(admin, path, target) {
  const res = await admin.graphql(CREATE_REDIRECT, {
    variables: { redirect: { path, target } },
  });
  const json = await res.json();
  const errs = json.errors ?? json.data?.urlRedirectCreate?.userErrors ?? [];
  return {
    ok: errs.length === 0,
    error: errs.length ? errs.map((e) => e.message).join("; ") : null,
    redirect: json.data?.urlRedirectCreate?.urlRedirect ?? null,
  };
}
