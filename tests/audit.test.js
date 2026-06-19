import { runAudit } from "../app/lib/audit.server.js";

const adminWith = (nodes) => ({
  graphql: jest.fn().mockResolvedValue({
    json: async () => ({
      data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
    }),
  }),
});

describe("runAudit", () => {
  test("a clean product scores 100 with no issues", async () => {
    const admin = adminWith([
      {
        id: "1",
        title: "T",
        handle: "t",
        productType: "Shoes",
        seo: {
          title: "Good title under sixty",
          description:
            "A description comfortably between fifty and one hundred sixty characters long for SEO.",
        },
        featuredImage: { altText: "alt" },
      },
    ]);
    const r = await runAudit(admin);
    expect(r.scanned).toBe(1);
    expect(r.score).toBe(100);
    expect(r.issues.every((i) => i.count === 0)).toBe(true);
  });

  test("counts missing title / description / alt", async () => {
    const admin = adminWith([
      { id: "1", title: "T", handle: "t", productType: "", seo: { title: "", description: "" }, featuredImage: null },
    ]);
    const r = await runAudit(admin);
    const byKey = Object.fromEntries(r.issues.map((i) => [i.key, i.count]));
    expect(byKey.missing_title).toBe(1);
    expect(byKey.missing_description).toBe(1);
    expect(byKey.missing_image_alt).toBe(1);
    expect(r.score).toBeLessThan(100);
  });

  test("groups products by type for internal linking", async () => {
    const admin = adminWith([
      { id: "1", title: "A", handle: "a", productType: "Shoes", seo: { title: "x", description: "" }, featuredImage: { altText: "a" } },
      { id: "2", title: "B", handle: "b", productType: "Shoes", seo: { title: "x", description: "" }, featuredImage: { altText: "a" } },
    ]);
    const r = await runAudit(admin);
    expect(r.linkGroups[0]).toMatchObject({ type: "Shoes", count: 2 });
  });

  test("surfaces a GraphQL error", async () => {
    const admin = { graphql: jest.fn().mockResolvedValue({ json: async () => ({ errors: [{ message: "boom" }] }) }) };
    const r = await runAudit(admin);
    expect(r.error).toBe("boom");
  });
});
