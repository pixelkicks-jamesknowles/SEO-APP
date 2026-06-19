// Parse a CSV of redirects ("from,to" per line). Tolerant: skips blanks, an optional header
// row, and lines whose `from` isn't a path. Pure + deterministic (unit-tested).
export function parseCsvRedirects(text) {
  const out = [];
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^from\s*,/i.test(line)) continue; // header row
    const [from, to] = line.split(",").map((c) => (c || "").trim());
    if (from && to && from.startsWith("/")) out.push({ from, to });
  }
  return out;
}
