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

/** The body of `async function persist(...)`, comments removed. Brace-matched from its opening brace. */
function persistBody() {
  const src = stripComments(fs.readFileSync(SRC, "utf8"));
  const start = src.indexOf("async function persist");
  expect(start).toBeGreaterThan(-1); // renamed? update this guard rather than deleting it
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error("could not brace-match persist()");
}

describe("persist() runs inside a transaction, so it must not swallow errors", () => {
  test("no .catch() anywhere in persist() — a caught error still aborts the Postgres transaction", () => {
    expect(persistBody()).not.toMatch(/\.catch\s*\(/);
  });

  test("no bare .create() on customerAttribution — a PK conflict there is what wedged the backfill", () => {
    // The fill-in-only write must be an upsert with an empty `update`: creates when absent, no-ops when
    // present, and cannot conflict. `.create()` here is expected to throw on an existing row, which is
    // exactly the thing that cannot be allowed inside the transaction.
    expect(persistBody()).not.toMatch(/customerAttribution\s*\n?\s*\.create\s*\(/);
    expect(persistBody()).toMatch(/customerAttribution\.upsert/);
  });
});
