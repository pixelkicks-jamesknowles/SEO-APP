import { buildChecklist, checklistStatus } from "../app/lib/wizard.js";

describe("buildChecklist", () => {
  test("empty settings → base checks all failing", () => {
    const items = buildChecklist({}, {});
    expect(items.map((i) => i.key)).toEqual(["destination", "serverSide", "pixel"]);
    expect(items.every((i) => !i.ok)).toBe(true);
    expect(checklistStatus(items)).toBe("empty");
  });

  test("GA4 configured adds secret + purchase-matrix checks", () => {
    const settings = {
      ga4Id: "G-XXesc", serverSide: true, webPixelId: "gid://x",
      eventMatrix: JSON.stringify({ ga4: ["checkout_completed", "page_viewed"] }),
    };
    const items = buildChecklist(settings, { ga4ApiSecret: "s" });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i.ok]));
    expect(byKey.destination).toBe(true);
    expect(byKey.serverSide).toBe(true);
    expect(byKey.pixel).toBe(true);
    expect(byKey.ga4secret).toBe(true);
    expect(byKey.ga4purchase).toBe(true);
    expect(checklistStatus(items)).toBe("ready");
  });

  test("GA4 without secret or purchase event flags those checks", () => {
    const settings = { ga4Id: "G-X", serverSide: true, webPixelId: "gid://x", eventMatrix: "{}" };
    const items = buildChecklist(settings, {});
    const byKey = Object.fromEntries(items.map((i) => [i.key, i.ok]));
    expect(byKey.ga4secret).toBe(false);
    expect(byKey.ga4purchase).toBe(false);
    expect(checklistStatus(items)).toBe("partial");
  });

  test("Meta pixel adds a CAPI token check", () => {
    const items = buildChecklist({ metaPixelId: "123", serverSide: true }, {});
    expect(items.find((i) => i.key === "metatoken")).toBeTruthy();
  });

  test("malformed eventMatrix doesn't throw", () => {
    const items = buildChecklist({ ga4Id: "G-X", eventMatrix: "not json" }, { ga4ApiSecret: "s" });
    expect(items.find((i) => i.key === "ga4purchase").ok).toBe(false);
  });
});
