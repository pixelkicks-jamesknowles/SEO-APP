import { clickIdChannel } from "../app/lib/click-ids.js";
import { parseUtms, orderChannel, orderHasJourney } from "../app/lib/attribution.js";
import { channelFromJourney, mediumFromSourceType } from "../app/lib/backfill.js";
import { channelGroupOf, referrerChannel } from "../app/lib/attribution-report.js";

describe("clickIdChannel", () => {
  test("Google Ads auto-tagging is recognised as paid search", () => {
    expect(clickIdChannel("/products/x?gclid=abc123")).toEqual({ source: "google", medium: "cpc", campaign: null });
    expect(clickIdChannel("/?gbraid=a")).toEqual({ source: "google", medium: "cpc", campaign: null });
    expect(clickIdChannel("/?wbraid=a")).toEqual({ source: "google", medium: "cpc", campaign: null });
  });

  test("other unambiguously-paid networks", () => {
    expect(clickIdChannel("/?msclkid=a").source).toBe("bing");
    expect(clickIdChannel("/?ttclid=a")).toEqual({ source: "tiktok", medium: "cpc", campaign: null });
    expect(clickIdChannel("/?ScCid=a")).toEqual({ source: "snapchat", medium: "cpc", campaign: null }); // mixed case on the wire
  });

  test("fbclid is NOT treated as paid — Facebook adds it to organic links too", () => {
    expect(clickIdChannel("/?fbclid=abc")).toEqual({ source: "facebook", medium: "social", campaign: null });
  });

  test("a paid click id wins over an ambiguous one", () => {
    expect(clickIdChannel("/?fbclid=a&gclid=b").medium).toBe("cpc");
  });

  test("no click id, junk input, and empty values return null", () => {
    expect(clickIdChannel("/products/x?utm_source=newsletter")).toBeNull();
    expect(clickIdChannel("/?gclid=")).toBeNull();
    expect(clickIdChannel("")).toBeNull();
    expect(clickIdChannel(null)).toBeNull();
  });
});

describe("parseUtms — auto-tagged paid clicks stop reading as direct", () => {
  test("gclid with no UTMs at all resolves the channel", () => {
    // This is the headline case: Google Ads auto-tagging sends no utm_* whatsoever.
    expect(parseUtms({ landing_site: "/collections/all?gclid=xyz" })).toEqual({ source: "google", medium: "cpc", campaign: null });
  });

  test("hand-tagged UTMs always win over a click id", () => {
    const order = { landing_site: "/?gclid=xyz&utm_source=newsletter&utm_medium=email&utm_campaign=spring" };
    expect(parseUtms(order)).toEqual({ source: "newsletter", medium: "email", campaign: "spring" });
  });

  test("an untagged order is still empty", () => {
    expect(parseUtms({ landing_site: "/products/x" })).toEqual({ source: null, medium: null, campaign: null });
  });
});

describe("orderChannel — referring site recovers organic search", () => {
  test("organic Google search is no longer indistinguishable from direct", () => {
    const order = { landing_site: "/products/x", referring_site: "https://www.google.com/" };
    expect(orderChannel(order)).toEqual({ source: "google", medium: "organic", campaign: null });
  });

  test("a click id beats the referrer", () => {
    const order = { landing_site: "/?gclid=x", referring_site: "https://www.google.com/" };
    expect(orderChannel(order).medium).toBe("cpc");
  });

  test("a genuinely direct visit yields nothing", () => {
    expect(orderChannel({ landing_site: "/" })).toBeNull();
  });
});

describe("orderHasJourney — (direct) vs (unattributed)", () => {
  test("a browser visit with no marketing signal really was direct", () => {
    expect(orderHasJourney({ landing_site: "/" })).toBe(true);
  });

  test("an order with no journey at all is unknowable, not direct", () => {
    // A subscription renewal or an imported order never involved a browser visit, so folding it into
    // Direct would inflate the best-looking channel.
    expect(orderHasJourney({ id: 1, line_items: [] })).toBe(false);
  });
});

describe("mediumFromSourceType — Shopify's MarketingTactic enum", () => {
  test("AD and RETARGETING are paid", () => {
    expect(mediumFromSourceType("AD")).toBe("cpc");
    expect(mediumFromSourceType("RETARGETING")).toBe("retargeting");
  });

  test("SEO and the email tactics", () => {
    expect(mediumFromSourceType("SEO")).toBe("organic");
    expect(mediumFromSourceType("NEWSLETTER")).toBe("email");
    expect(mediumFromSourceType("ABANDONED_CART")).toBe("email");
  });

  test("absent or unknown falls back to the previous behaviour", () => {
    expect(mediumFromSourceType(null)).toBe("referral");
    expect(mediumFromSourceType("SOME_FUTURE_TACTIC")).toBe("referral");
  });
});

describe("channelFromJourney — the Organic Social misfiling", () => {
  const journey = (firstVisit) => ({ firstVisit });

  test("a Meta AD click now classifies as Paid Social, not Organic Social", () => {
    const ch = channelFromJourney(journey({ source: "facebook", sourceType: "AD" }));
    expect(ch).toEqual({ source: "facebook", medium: "cpc", campaign: null });
    expect(channelGroupOf(ch.source, ch.medium)).toBe("Paid Social");
  });

  test("an organic Facebook post still classifies as Organic Social", () => {
    const ch = channelFromJourney(journey({ source: "facebook", sourceType: "POST" }));
    expect(channelGroupOf(ch.source, ch.medium)).toBe("Organic Social");
  });

  test("a Google ad is Paid Search; SEO is Organic Search", () => {
    const ad = channelFromJourney(journey({ source: "google", sourceType: "AD" }));
    expect(channelGroupOf(ad.source, ad.medium)).toBe("Paid Search");
    const seo = channelFromJourney(journey({ source: "google", sourceType: "SEO" }));
    expect(channelGroupOf(seo.source, seo.medium)).toBe("Organic Search");
  });

  test("a click id on the landing page is used when there is no sourceType", () => {
    const ch = channelFromJourney(journey({ source: "google", landingPage: "https://shop.com/?gclid=x" }));
    expect(ch).toEqual({ source: "google", medium: "cpc", campaign: null });
  });

  test("UTMs still win over everything", () => {
    const ch = channelFromJourney(journey({ source: "facebook", sourceType: "AD", utmParameters: { source: "klaviyo", medium: "email", campaign: "vip" } }));
    expect(ch).toEqual({ source: "klaviyo", medium: "email", campaign: "vip" });
  });

  test("no sourceType falls back to referral, exactly as before", () => {
    expect(channelFromJourney(journey({ source: "somewhere.com" }))).toEqual({ source: "somewhere.com", medium: "referral", campaign: null });
  });
});

describe("referrerChannel is shared by the visit and order paths", () => {
  test("same classification either side", () => {
    expect(referrerChannel("https://www.google.com/search?q=x")).toEqual({ source: "google", medium: "organic", campaign: null });
    expect(referrerChannel("https://l.facebook.com/")).toEqual({ source: "facebook", medium: "social", campaign: null });
    expect(referrerChannel("https://someblog.co.uk/post")).toEqual({ source: "someblog.co.uk", medium: "referral", campaign: null });
    expect(referrerChannel(null)).toBeNull();
  });
});
