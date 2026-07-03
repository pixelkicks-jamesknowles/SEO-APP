import { effectiveDataLayerConfig, DATA_LAYER_EVENTS } from "../app/lib/datalayer.js";

describe("effectiveDataLayerConfig", () => {
  test("reports enabled only when the persisted flag is true (the Pro gate is applied at toggle time)", () => {
    expect(effectiveDataLayerConfig({ dataLayerEnabled: true }).enabled).toBe(true);
    expect(effectiveDataLayerConfig({ dataLayerEnabled: false }).enabled).toBe(false);
    expect(effectiveDataLayerConfig(null).enabled).toBe(false); // no settings row → off
    expect(effectiveDataLayerConfig({}).enabled).toBe(false);
  });

  test("emits both the GA4-standard and the dl_* mirror formats", () => {
    expect(effectiveDataLayerConfig({ dataLayerEnabled: true }).formats).toEqual(["ga4", "dl"]);
  });

  test("carries the browse-funnel event list and never includes purchase (server-side only)", () => {
    const cfg = effectiveDataLayerConfig({ dataLayerEnabled: true });
    expect(cfg.events).toEqual(DATA_LAYER_EVENTS);
    expect(cfg.events).toEqual(expect.arrayContaining(["view_item", "add_to_cart", "begin_checkout", "view_cart", "view_item_list", "user_data"]));
    expect(cfg.events).not.toContain("purchase");
  });
});
