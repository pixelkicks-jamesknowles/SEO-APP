/* eslint-disable import/first -- jest.mock() must precede the imports it intercepts */
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { visitorKey, eventCustomerKey, linkIdentity, resolveCustomerKey, identityStats } from "../app/lib/identity.server.js";
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
});

describe("identityStats", () => {
  test("reports total visitors + identified count", async () => {
    prisma.visitorIdentity.count.mockResolvedValueOnce(120).mockResolvedValueOnce(34);
    expect(await identityStats(SHOP)).toEqual({ visitors: 120, identified: 34 });
  });
});
