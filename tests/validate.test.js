import { validateUrl } from "../app/lib/validate.server.js";

const mockHtml = (html) => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => html });
};

afterEach(() => {
  global.fetch = undefined;
});

describe("validateUrl", () => {
  test("flags missing required fields on Product", async () => {
    mockHtml(`<script type="application/ld+json">{"@type":"Product","name":"X"}</script>`);
    const r = await validateUrl("https://x.com/p");
    expect(r.found).toBe(1);
    expect(r.results[0].type).toBe("Product");
    expect(r.results[0].valid).toBe(false);
    expect(r.results[0].missing).toContain("offers");
  });

  test("a complete Product passes", async () => {
    mockHtml(
      `<script type="application/ld+json">{"@type":"Product","name":"X","offers":{"price":"1","priceCurrency":"USD"}}</script>`,
    );
    const r = await validateUrl("https://x.com/p");
    expect(r.results.find((x) => x.type === "Product").valid).toBe(true);
  });

  test("no JSON-LD → found 0", async () => {
    mockHtml("<html><body>hello</body></html>");
    const r = await validateUrl("https://x.com");
    expect(r.found).toBe(0);
  });

  test("reads @graph arrays", async () => {
    mockHtml(
      `<script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"A","url":"https://x.com"}]}</script>`,
    );
    const r = await validateUrl("https://x.com");
    expect(r.results[0]).toMatchObject({ type: "Organization", valid: true });
  });

  test("fetch failure surfaces an error", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    const r = await validateUrl("https://x.com");
    expect(r.error).toMatch(/500/);
  });
});
