import { detectTrackersInHtml, scanStorefront } from "../app/lib/pixel-scan.server.js";

const keys = (html) => detectTrackersInHtml(html).map((d) => d.key);

test("detects a GA4 gtag snippet", () => {
  const html = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234567"></script>`;
  expect(keys(html)).toContain("ga4");
});

test("detects a Meta pixel", () => {
  const html = `<script>fbq('init', '123456789');fbq('track','PageView');</script>`;
  expect(keys(html)).toContain("meta");
});

test("detects a GTM container and TikTok pixel together", () => {
  const html = `<!-- GTM --><script>(function(){})();</script>googletagmanager.com/gtm.js?id=GTM-ABCD ttq.load('C4XYZ')`;
  const k = keys(html);
  expect(k).toEqual(expect.arrayContaining(["gtm", "tiktok"]));
});

test("returns nothing for clean HTML", () => {
  expect(detectTrackersInHtml("<html><body>hello</body></html>")).toEqual([]);
});

test("handles non-string input without throwing", () => {
  expect(detectTrackersInHtml(null)).toEqual([]);
  expect(detectTrackersInHtml(undefined)).toEqual([]);
});

describe("scanStorefront — the network path", () => {
  const okHtml = (html) => ({ ok: true, status: 200, text: async () => html });

  afterEach(() => {
    delete global.fetch;
  });

  test("detects trackers on a reachable storefront", async () => {
    global.fetch = jest.fn(async () => okHtml('<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC"></script>'));
    const res = await scanStorefront("shop.myshopify.com");
    expect(res.ok).toBe(true);
    expect(res.url).toBe("https://shop.myshopify.com/");
    expect(res.detected.length).toBeGreaterThan(0);
  });

  test("a password-protected store is reported, not thrown", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => "" }));
    const res = await scanStorefront("shop.myshopify.com");
    expect(res.ok).toBe(false);
    expect(res.note).toMatch(/HTTP 401|password/i);
  });

  test("a timeout is reported as such rather than crashing the settings page", async () => {
    global.fetch = jest.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const res = await scanStorefront("shop.myshopify.com", { timeoutMs: 5 });
    expect(res).toMatchObject({ ok: false, detected: [] });
    expect(res.note).toMatch(/too long/i);
  });

  test("a network failure is caught and surfaced", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const res = await scanStorefront("shop.myshopify.com");
    expect(res).toMatchObject({ ok: false, detected: [] });
    expect(res.note).toMatch(/ENOTFOUND/);
  });

  test("no shop domain short-circuits without a request", async () => {
    global.fetch = jest.fn();
    const res = await scanStorefront("");
    expect(res).toMatchObject({ ok: false, detected: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
