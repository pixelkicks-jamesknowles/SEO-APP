import { detectTrackersInHtml } from "../app/lib/pixel-scan.server.js";

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
