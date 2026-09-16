import fs from "node:fs";
import path from "node:path";

// Regression guard for a silent shadowing bug that shipped and ran for days.
//
// seo-engagement.js contained TWO `function syncCartIds()` declarations. JavaScript hoists function
// declarations and a later one OVERWRITES an earlier one of the same name, so the second — an older
// version that wrote only the GA ids and bailed on `!analyticsAllowed()` — is the one that actually ran.
// The newer consent-capturing version above it was dead code from the day it was added.
//
// The damage was invisible in exactly the way that costs time: orders carried `ga_client_id` and
// `ga_session_id` (so the embed was obviously alive and working) but never `pxp_analytics_consent`. The
// Accuracy page therefore read "No consent signal captured on any of 6,067 paid orders" and told the
// merchant to enable a theme embed that had been enabled all along.
//
// ESLint's no-redeclare would have caught it, but `extensions` is in .eslintignore, so nothing linted this
// file at all. Until that changes, this test is the check.
const ASSET_DIRS = [
  path.join(__dirname, "..", "extensions", "seo-engagement", "assets"),
  path.join(__dirname, "..", "extensions", "seo-engagement", "blocks"),
];

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function assetFiles() {
  return ASSET_DIRS.filter((d) => fs.existsSync(d)).flatMap((d) =>
    fs
      .readdirSync(d)
      .filter((f) => f.endsWith(".js"))
      .map((f) => path.join(d, f)),
  );
}

/** Every `function name(` declaration in a file, with how many times it appears. */
function declarationCounts(src) {
  const counts = new Map();
  for (const m of stripComments(src).matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return counts;
}

describe("theme embed assets declare each function exactly once", () => {
  test("no function name is declared twice (a later one silently replaces the earlier)", () => {
    const offenders = [];
    for (const file of assetFiles()) {
      for (const [name, n] of declarationCounts(fs.readFileSync(file, "utf8"))) {
        if (n > 1) offenders.push(`${path.basename(file)}: ${name} declared ${n}x`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the embed still writes the consent attribute on every cart sync", () => {
    // The specific casualty of the shadowing. Consent must be recorded whether it was granted OR denied —
    // "denied" is the value the reporting actually needs, and it is only knowable here.
    const src = stripComments(fs.readFileSync(path.join(ASSET_DIRS[0], "seo-engagement.js"), "utf8"));
    expect(src).toMatch(/pxp_analytics_consent:\s*allowed\s*\?\s*"granted"\s*:\s*"denied"/);
  });
});
