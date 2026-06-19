// Core Web Vitals field data via the Google CrUX API (merchant supplies an API key).

export async function fetchCrux(apiKey, origin) {
  if (!apiKey) return { error: "Add a CrUX API key in Settings." };
  try {
    const res = await fetch(
      `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin, formFactor: "PHONE" }),
      },
    );
    const json = await res.json();
    if (json.error) return { error: json.error.message || "CrUX request failed." };
    const m = json.record?.metrics ?? {};
    const p75 = (k) => m[k]?.percentiles?.p75 ?? null;
    return {
      lcp: p75("largest_contentful_paint"),
      inp: p75("interaction_to_next_paint"),
      cls: p75("cumulative_layout_shift"),
    };
  } catch (e) {
    return { error: e.message };
  }
}
