import { gql } from "./graphql.server";

// Deterministic technical-SEO audit. Read-only — paginates products and runs rule checks,
// returning a score + grouped issues with sample offenders. No writes, no AI.

const AUDIT_QUERY = `#graphql
  query AuditProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        productType
        seo { title description }
        featuredImage { altText }
      }
    }
  }`;

const CHECKS = [
  { key: "missing_title", label: "Missing SEO title", test: (p) => !p.seo?.title },
  { key: "missing_description", label: "Missing meta description", test: (p) => !p.seo?.description },
  { key: "title_too_long", label: "SEO title over 60 characters", test: (p) => (p.seo?.title?.length || 0) > 60 },
  { key: "description_too_long", label: "Meta description over 160 characters", test: (p) => (p.seo?.description?.length || 0) > 160 },
  { key: "description_too_short", label: "Meta description under 50 characters", test: (p) => !!p.seo?.description && p.seo.description.length < 50 },
  { key: "missing_image_alt", label: "Featured image missing alt text", test: (p) => !p.featuredImage?.altText },
];

export async function runAudit(admin, { maxProducts = 150 } = {}) {
  let cursor = null;
  let scanned = 0;
  let truncated = false;
  const issues = Object.fromEntries(
    CHECKS.map((c) => [c.key, { key: c.key, label: c.label, count: 0, samples: [] }]),
  );
  const byType = {}; // productType → [titles], for internal-linking suggestions

  while (scanned < maxProducts) {
    const json = await gql(admin, AUDIT_QUERY, { cursor });
    if (json.errors) return { error: json.errors.map((e) => e.message).join("; ") };
    const conn = json.data?.products;
    for (const p of conn?.nodes ?? []) {
      scanned += 1;
      for (const c of CHECKS) {
        if (c.test(p)) {
          const rec = issues[c.key];
          rec.count += 1;
          if (rec.samples.length < 5) rec.samples.push(p.title);
        }
      }
      if (p.productType) (byType[p.productType] ||= []).push(p.title);
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (scanned >= maxProducts) {
      truncated = true;
      break;
    }
  }

  const totalChecks = scanned * CHECKS.length;
  const totalIssues = Object.values(issues).reduce((sum, i) => sum + i.count, 0);
  const score = totalChecks ? Math.round(((totalChecks - totalIssues) / totalChecks) * 100) : 100;

  // Internal-linking opportunities: products sharing a type that should cross-link.
  const linkGroups = Object.entries(byType)
    .filter(([, titles]) => titles.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([type, titles]) => ({ type, count: titles.length, samples: titles.slice(0, 4) }));

  return { scanned, truncated, score, issues: Object.values(issues), linkGroups };
}
