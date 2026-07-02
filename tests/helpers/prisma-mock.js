// Reusable Prisma mock for the integration tests. The real client (app/db.server.js) instantiates a
// PrismaClient and talks to Postgres, which we can't (and don't want to) do in unit tests. Instead each
// integration test does:
//
//   jest.mock("../../app/db.server.js", () => ({ __esModule: true, default: require("../helpers/prisma-mock").makePrismaMock() }));
//   import prisma from "../../app/db.server.js";
//
// and then, in beforeEach, re-seeds the return values it cares about (see below). Every model method
// returns a resolved promise by default, so the app code's `.catch()` / `.then()` chains never blow up
// on an un-stubbed call.
//
// Isolation pattern (per test file):
//   beforeEach(() => {
//     jest.clearAllMocks();                                  // reset call counts
//     prisma.trackingSettings.findUnique.mockResolvedValue(...); // re-establish the baseline (overwrites
//                                                               // any persistent value a prior test set)
//   });
// Because mockResolvedValue overwrites, re-seeding the baseline every beforeEach prevents cross-test leak.

// Sensible empty defaults per Prisma method (shape mirrors what the real client returns).
const DEFAULTS = {
  findUnique: null,
  findFirst: null,
  findMany: [],
  create: {},
  createMany: { count: 0 },
  update: {},
  updateMany: { count: 0 },
  upsert: {},
  delete: {},
  deleteMany: { count: 0 },
  count: 0,
};

function makeModel() {
  const model = {};
  for (const [method, value] of Object.entries(DEFAULTS)) {
    // Clone object defaults so a caller mutating a returned row can't poison the next call.
    model[method] = jest.fn(async () =>
      value && typeof value === "object" ? (Array.isArray(value) ? [...value] : { ...value }) : value,
    );
  }
  return model;
}

/** A Proxy that lazily materializes a mocked model (trackingSettings, deliveryOutbox, …) on first
 *  access and caches it, so `prisma.anyModel.anyMethod` is always a jest.fn returning a resolved promise. */
export function makePrismaMock() {
  const models = {};
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "__models") return models; // escape hatch for advanced resets
        if (typeof prop === "symbol" || prop === "then") return undefined; // not a thenable
        if (!models[prop]) models[prop] = makeModel();
        return models[prop];
      },
    },
  );
}
