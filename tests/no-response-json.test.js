import fs from "node:fs";
import path from "node:path";

// Regression guard for a production-only 500.
//
// remix-serve runs on the @remix-run/web-fetch polyfill, which implements Response but NOT the static
// `Response.json()` helper. Calling it throws "TypeError: Response.json is not a function" at runtime —
// a 500 that never appears in dev or in these tests (routes aren't unit-tested), so it shipped silently
// and broke /proxy/id (the durable-id cookie was on the response that threw, so pxp_id never minted and
// the identity graph stayed empty) and every /cron/tick response.
//
// Always use Remix's `json()` helper from @remix-run/node instead.
const ROOT = path.join(__dirname, "..", "app");

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(p));
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

// Strip comments so the rule doesn't trip on docs/notes that legitimately name the banned call.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("no static Response.json() in app source", () => {
  test("every route/lib uses Remix's json() helper (the static one throws under remix-serve)", () => {
    const offenders = jsFiles(ROOT).filter((f) => /Response\.json\s*\(/.test(stripComments(fs.readFileSync(f, "utf8"))));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
