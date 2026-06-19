import { fetchCrux } from "../app/lib/crux.server.js";

afterEach(() => {
  global.fetch = undefined;
});

describe("fetchCrux", () => {
  test("no API key → error", async () => {
    const r = await fetchCrux("", "https://x.com");
    expect(r.error).toBeTruthy();
  });

  test("parses p75 metrics, nulls missing ones", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        record: {
          metrics: {
            largest_contentful_paint: { percentiles: { p75: 2100 } },
            cumulative_layout_shift: { percentiles: { p75: "0.05" } },
          },
        },
      }),
    });
    const r = await fetchCrux("key", "https://x.com");
    expect(r.lcp).toBe(2100);
    expect(r.cls).toBe("0.05");
    expect(r.inp).toBeNull();
  });

  test("surfaces an API error", async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ error: { message: "bad key" } }) });
    const r = await fetchCrux("key", "https://x.com");
    expect(r.error).toBe("bad key");
  });
});
