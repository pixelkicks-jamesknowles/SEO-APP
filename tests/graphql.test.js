import { gql } from "../app/lib/graphql.server.js";

describe("gql", () => {
  test("returns parsed json on success", async () => {
    const admin = { graphql: jest.fn().mockResolvedValue({ json: async () => ({ data: { ok: 1 } }) }) };
    expect(await gql(admin, "query")).toEqual({ data: { ok: 1 } });
  });

  test("passes variables through when provided", async () => {
    const admin = { graphql: jest.fn().mockResolvedValue({ json: async () => ({ data: {} }) }) };
    await gql(admin, "query", { id: "1" });
    expect(admin.graphql).toHaveBeenCalledWith("query", { variables: { id: "1" } });
  });

  test("returns throttled response once retries are exhausted", async () => {
    const admin = {
      graphql: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ errors: [{ extensions: { code: "THROTTLED" } }] }) }),
    };
    const json = await gql(admin, "query", null, { retries: 0 });
    expect(json.errors[0].extensions.code).toBe("THROTTLED");
    expect(admin.graphql).toHaveBeenCalledTimes(1);
  });
});
