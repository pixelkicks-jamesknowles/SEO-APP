import fs from "node:fs";
import path from "node:path";

// Regression guard for a production wedge that ran for a day.
//
// `persist()` runs inside prisma.$transaction. In Postgres a failed statement aborts the ENTIRE
// transaction (SQLSTATE 25P02, "current transaction is aborted, commands ignored until end of transaction
// block") — and catching the JavaScript error does NOT undo that. Every later statement in the same
// transaction fails too.
//
// persist() used to end with a deliberate create-and-catch:
//
//     await db.customerAttribution.create({ ... }).catch(() => {});  // row exists → stored value wins
//
// which is correct OUTSIDE a transaction and fatal inside one. The first time a page contained a customer
// who already had a firstSubscriptionOrderId, the INSERT hit the (shopDomain, customerKey) primary key,
// poisoned the transaction, and the cursor advance in the same transaction then failed with 25P02. Nothing
// committed, the cursor never moved, and the identical page was retried on every tick — forever. A live
// backfill sat on exactly 230,100 orders for a day showing a healthy "running" banner.
//
// It is deterministic, not a race, so it cannot clear on its own. The rule: inside the transaction, no
// swallowed errors. Use an upsert that cannot conflict, and let anything genuinely unexpected propagate so
// the page rolls back honestly (which is what persist()'s own docstring promises).
const SRC = path.join(__dirname, "..", "app", "lib", "backfill.server.js");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The body of a named `async function`, comments removed. Brace-matched from its opening brace. */
function fnBody(name) {
  const src = stripComments(fs.readFileSync(SRC, "utf8"));
  const start = src.indexOf(`async function ${name}`);
  expect(start).toBeGreaterThan(-1); // renamed? update this guard rather than deleting it
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error(`could not brace-match ${name}()`);
}

describe("the page write path must not swallow errors", () => {
  // persistCounters runs INSIDE prisma.$transaction, where a swallowed error is not survivable at all.
  // persistIdempotent runs outside it, but a swallowed failure there would silently skip a page's
  // first-touch and (unattributed) rows while the cursor advanced past them — lost permanently, since the
  // page is never revisited. Neither may catch.
  test.each(["persistCounters", "persistIdempotent"])("no .catch() anywhere in %s()", (fn) => {
    expect(fnBody(fn)).not.toMatch(/\.catch\s*\(/);
  });

  test("no bare .create() on customerAttribution — a PK conflict there is what wedged the backfill", () => {
    // The fill-in-only write must be an upsert with an empty `update`: creates when absent, no-ops when
    // present, and cannot conflict. `.create()` is expected to throw on an existing row, which inside a
    // transaction aborts everything after it.
    expect(fnBody("persistIdempotent")).not.toMatch(/customerAttribution\s*\n?\s*\.create\s*\(/);
    expect(fnBody("persistIdempotent")).toMatch(/customerAttribution\.upsert/);
  });

  // The whole point of the split: keep the transaction small. If an increment-based table ever moves out
  // of it, or a bulk idempotent write moves in, the timeout problem comes straight back.
  test("only the increment-based tables are inside the transaction", () => {
    const counters = fnBody("persistCounters");
    expect(counters).toMatch(/channelRevenueDaily/);
    expect(counters).toMatch(/customerLifetime/);
    expect(counters).not.toMatch(/unattributedOrder|customerAttribution/);
  });

  test("the idempotent writes run BEFORE the transaction, not after", () => {
    // After it, a process death between commit and these writes would advance the cursor past a page whose
    // rows never landed. Before it, a retry simply re-applies them.
    const src = stripComments(fs.readFileSync(SRC, "utf8"));
    expect(src.indexOf("persistIdempotent(prisma")).toBeLessThan(src.indexOf("prisma.$transaction"));
  });
});
