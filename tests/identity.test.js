/* eslint-disable import/first -- jest.mock() must precede the imports it intercepts */
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { visitorKey, eventCustomerKey, linkIdentity, resolveCustomerKey, resolveIdentityFirstTouch, identityStats, stitchIdentityFromOrder } from "../app/lib/identity.server.js";
import { sha256Hex } from "../app/lib/server-side.server.js";

const SHOP = "s.myshopify.com";
beforeEach(() => jest.clearAllMocks());

describe("visitorKey", () => {
  test("prefers the durable id, falls back to clientId, else null", () => {
    expect(visitorKey({ durableId: "d1", clientId: "c1" })).toBe("d1");
    expect(visitorKey({ clientId: "c1" })).toBe("c1");
    expect(visitorKey({})).toBeNull();
  });
});

describe("eventCustomerKey", () => {
  test("uses the customer id, else a hashed email, else null", () => {
    expect(eventCustomerKey({ externalId: 991 })).toBe("991");
    expect(eventCustomerKey({ email: "Buyer@Example.com" })).toBe(`e:${sha256Hex("Buyer@Example.com")}`);
    expect(eventCustomerKey({ data: { checkout: { email: "c@d.com" } } })).toBe(`e:${sha256Hex("c@d.com")}`);
    expect(eventCustomerKey({})).toBeNull();
  });
});

describe("linkIdentity", () => {
  test("no-op without a durable id", async () => {
    await linkIdentity(SHOP, { clientId: "c1" });
    expect(prisma.visitorIdentity.upsert).not.toHaveBeenCalled();
  });

  test("upserts the durable id, only setting the ids it knows (never nulling)", async () => {
    await linkIdentity(SHOP, { durableId: "d1", clientId: "c1", customerKey: null });
    const call = prisma.visitorIdentity.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ shopDomain_durableId: { shopDomain: SHOP, durableId: "d1" } });
    expect(call.update).toEqual({ clientId: "c1" }); // customerKey omitted → not overwritten to null
    expect(call.create).toMatchObject({ durableId: "d1", clientId: "c1", customerKey: null });
  });

  test("sets the customer link once the visitor identifies", async () => {
    await linkIdentity(SHOP, { durableId: "d1", customerKey: "991" });
    expect(prisma.visitorIdentity.upsert.mock.calls[0][0].update).toEqual({ customerKey: "991" });
  });

  test("cross-channel stitch: a checkout event (clientId + customerKey, NO durable id) identifies durable rows sharing the client id", async () => {
    await linkIdentity(SHOP, { clientId: "c1", customerKey: "991" });
    // No durable id → no upsert, but the client-id stitch attaches the customer to anonymous durable rows.
    expect(prisma.visitorIdentity.upsert).not.toHaveBeenCalled();
    expect(prisma.visitorIdentity.updateMany).toHaveBeenCalledWith({
      where: { shopDomain: SHOP, clientId: "c1", customerKey: null },
      data: { customerKey: "991" },
    });
  });

  test("with a durable id AND a client id, does both the upsert and the client-id stitch", async () => {
    await linkIdentity(SHOP, { durableId: "d1", clientId: "c1", customerKey: "991" });
    expect(prisma.visitorIdentity.upsert).toHaveBeenCalled();
    expect(prisma.visitorIdentity.updateMany).toHaveBeenCalledWith({
      where: { shopDomain: SHOP, clientId: "c1", customerKey: null },
      data: { customerKey: "991" },
    });
  });
});

describe("resolveCustomerKey", () => {
  test("returns the linked customer for a durable id", async () => {
    prisma.visitorIdentity.findUnique.mockResolvedValue({ customerKey: "991" });
    expect(await resolveCustomerKey(SHOP, "d1")).toBe("991");
  });
  test("null when unknown / anonymous", async () => {
    prisma.visitorIdentity.findUnique.mockResolvedValue(null);
    expect(await resolveCustomerKey(SHOP, "d1")).toBeNull();
    expect(await resolveCustomerKey(SHOP, null)).toBeNull();
  });
  test("best-effort: a lookup failure resolves to null, never throws", async () => {
    prisma.visitorIdentity.findUnique.mockRejectedValue(new Error("db down"));
    await expect(resolveCustomerKey(SHOP, "d1")).resolves.toBeNull();
  });
});

describe("resolveIdentityFirstTouch (cross-device / cross-session)", () => {
  test("returns the earliest linked device's first-touch for the customer", async () => {
    // Two devices linked to the same customer; the mobile one (earliest) carries the original source.
    prisma.visitorIdentity.findMany.mockResolvedValue([
      { durableId: "mobile", clientId: "cm" },
      { durableId: "desktop", clientId: "cd" },
    ]);
    const firstTouchFor = jest.fn(async (_shop, key) => (key === "mobile" ? { source: "google", medium: "cpc" } : null));
    const ft = await resolveIdentityFirstTouch(SHOP, "991", firstTouchFor);
    expect(ft).toEqual({ source: "google", medium: "cpc" });
    expect(prisma.visitorIdentity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { shopDomain: SHOP, customerKey: "991" }, orderBy: { firstSeen: "asc" } }));
  });

  test("falls back to the client id when the durable id has no first-touch", async () => {
    prisma.visitorIdentity.findMany.mockResolvedValue([{ durableId: "d1", clientId: "c1" }]);
    const firstTouchFor = jest.fn(async (_shop, key) => (key === "c1" ? { source: "klaviyo", medium: "email" } : null));
    expect(await resolveIdentityFirstTouch(SHOP, "991", firstTouchFor)).toEqual({ source: "klaviyo", medium: "email" });
  });

  test("null when no customer key, no resolver, or nothing linked has a source", async () => {
    const firstTouchFor = jest.fn(async () => null);
    expect(await resolveIdentityFirstTouch(SHOP, null, firstTouchFor)).toBeNull();
    expect(await resolveIdentityFirstTouch(SHOP, "991", undefined)).toBeNull();
    prisma.visitorIdentity.findMany.mockResolvedValue([{ durableId: "d1", clientId: "c1" }]);
    expect(await resolveIdentityFirstTouch(SHOP, "991", firstTouchFor)).toBeNull();
  });

  test("best-effort: a graph lookup failure resolves to null, never throws", async () => {
    prisma.visitorIdentity.findMany.mockRejectedValue(new Error("db down"));
    await expect(resolveIdentityFirstTouch(SHOP, "991", jest.fn())).resolves.toBeNull();
  });
});

describe("identityStats", () => {
  test("reports total visitors + identified + the client-id diagnostic", async () => {
    prisma.visitorIdentity.count.mockResolvedValueOnce(120).mockResolvedValueOnce(34).mockResolvedValueOnce(98);
    expect(await identityStats(SHOP)).toEqual({ visitors: 120, identified: 34, withClientId: 98 });
  });

  test("withClientId tells the two causes of 'identified: 0' apart", async () => {
    // Nothing stitched AND no client ids recorded → the EMBED side is broken (nothing to match against).
    prisma.visitorIdentity.count.mockResolvedValueOnce(500).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    expect(await identityStats(SHOP)).toEqual({ visitors: 500, identified: 0, withClientId: 0 });

    // Nothing stitched but client ids ARE recorded → the CHECKOUT side is broken (no customer key, or a
    // different client id), which is a completely different fix.
    prisma.visitorIdentity.count.mockResolvedValueOnce(500).mockResolvedValueOnce(0).mockResolvedValueOnce(480);
    expect(await identityStats(SHOP)).toEqual({ visitors: 500, identified: 0, withClientId: 480 });
  });

  test("best-effort: a count failure resolves to zeros, never throws", async () => {
    prisma.visitorIdentity.count.mockRejectedValue(new Error("db down"));
    await expect(identityStats(SHOP)).resolves.toEqual({ visitors: 0, identified: 0, withClientId: 0 });
  });
});

// The order-driven identity stitch. This exists because the PIXEL path could not identify anyone on a
// live store: 23,895 visitors carried a GA client id and `identified` was 0, because the pixel's
// checkout event supplies a customer key only for a logged-in shopper with marketing consent, and its
// client id can differ from the one the embed stored. The order carries both halves reliably.
describe("stitchIdentityFromOrder", () => {
  const order = (over = {}) => ({
    customer: { id: 4242 },
    note_attributes: [{ name: "ga_client_id", value: "111.222" }],
    ...over,
  });

  test("joins the order's customer key to identities holding the embed's ga_client_id", async () => {
    prisma.visitorIdentity.updateMany.mockResolvedValue({ count: 3 });

    const stitched = await stitchIdentityFromOrder(SHOP, order());

    expect(stitched).toBe(3);
    expect(prisma.visitorIdentity.updateMany).toHaveBeenCalledWith({
      // customerKey: null → FILL-IN ONLY, so a value the live pipeline already captured is never clobbered
      // and re-running the backfill over the same orders is safe.
      where: { shopDomain: SHOP, clientId: "111.222", customerKey: null },
      data: { customerKey: "4242" },
    });
  });

  test("falls back to the hashed order email when there is no customer record (guest checkout)", async () => {
    await stitchIdentityFromOrder(SHOP, order({ customer: undefined, email: "a@b.com" }));
    expect(prisma.visitorIdentity.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { customerKey: "e:" + sha256Hex("a@b.com") } }),
    );
  });

  test("reads the backfill's normalized note_attributes shape too", async () => {
    // backfill.server maps GraphQL `customAttributes {key value}` → `note_attributes {name value}`, so the
    // same helper serves the live webhook and the historical backfill.
    prisma.visitorIdentity.updateMany.mockResolvedValue({ count: 1 });
    const fromBackfill = { customer: { id: "gid://shopify/Customer/77" }, note_attributes: [{ name: "ga_client_id", value: "999.888" }] };
    expect(await stitchIdentityFromOrder(SHOP, fromBackfill)).toBe(1);
    expect(prisma.visitorIdentity.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clientId: "999.888" }) }),
    );
  });

  test("no-ops without a ga_client_id — nothing to join against", async () => {
    expect(await stitchIdentityFromOrder(SHOP, order({ note_attributes: [] }))).toBe(0);
    expect(prisma.visitorIdentity.updateMany).not.toHaveBeenCalled();
  });

  test("no-ops without a customer key — the embed saw them but the order is anonymous", async () => {
    expect(await stitchIdentityFromOrder(SHOP, order({ customer: undefined }))).toBe(0);
    expect(prisma.visitorIdentity.updateMany).not.toHaveBeenCalled();
  });

  test("never writes a durable-id row — an order has no durableId to key one on", async () => {
    await stitchIdentityFromOrder(SHOP, order());
    expect(prisma.visitorIdentity.upsert).not.toHaveBeenCalled();
  });
});
