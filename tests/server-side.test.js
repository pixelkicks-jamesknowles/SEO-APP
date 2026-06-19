import { fanOutServerSide } from "../app/lib/server-side.server.js";

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});
afterEach(() => {
  global.fetch = undefined;
});

describe("fanOutServerSide", () => {
  test("no-op when serverSide is off", async () => {
    await fanOutServerSide({ serverSide: false }, { name: "product_viewed" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("fires GA4 + Meta when both are configured with keys", async () => {
    const settings = {
      serverSide: true,
      ga4Id: "G-1",
      metaPixelId: "P-1",
      serverSideKeys: JSON.stringify({ ga4ApiSecret: "s", metaCapiToken: "t" }),
    };
    await fanOutServerSide(settings, { name: "checkout_completed" });
    const urls = global.fetch.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes("google-analytics.com/mp/collect"))).toBe(true);
    expect(urls.some((u) => u.includes("graph.facebook.com"))).toBe(true);
  });

  test("fires only GA4 when only GA4 is configured", async () => {
    const settings = {
      serverSide: true,
      ga4Id: "G-1",
      serverSideKeys: JSON.stringify({ ga4ApiSecret: "s" }),
    };
    await fanOutServerSide(settings, { name: "page_viewed" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
