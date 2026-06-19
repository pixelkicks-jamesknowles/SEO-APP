// Rich Results validation. Fetches a public URL, extracts JSON-LD, and checks required fields
// per schema type against Google's rich-result expectations. No external API — deterministic.

const REQUIRED = {
  Product: ["name", "offers"],
  Offer: ["price", "priceCurrency"],
  BlogPosting: ["headline", "datePublished"],
  Article: ["headline", "datePublished"],
  FAQPage: ["mainEntity"],
  BreadcrumbList: ["itemListElement"],
  Organization: ["name", "url"],
  LocalBusiness: ["name", "address"],
  WebSite: ["url"],
};

export async function validateUrl(url) {
  let html;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "PixelifySEO-Validator" } });
    if (!res.ok) return { error: `Could not fetch the page (HTTP ${res.status}).` };
    html = await res.text();
  } catch (e) {
    return { error: e.message };
  }

  const hasLd = /application\/ld\+json/i.test(html);
  if (!hasLd && /store password|password-page|enter.*password/i.test(html)) {
    return { error: "The page looks password-protected (dev store). Validate a public/live URL." };
  }

  const blocks = [
    ...html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  if (blocks.length === 0) return { found: 0, results: [] };

  const results = [];
  for (const m of blocks) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      results.push({ type: "(unparseable)", valid: false, missing: ["valid JSON"] });
      continue;
    }
    const items = Array.isArray(data) ? data : data["@graph"] || [data];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const type = Array.isArray(item["@type"]) ? item["@type"][0] : item["@type"];
      const req = REQUIRED[type] || [];
      const missing = req.filter((f) => item[f] === undefined || item[f] === null || item[f] === "");
      results.push({ type: type || "(no @type)", valid: missing.length === 0, missing });
    }
  }
  return { found: results.length, results };
}
