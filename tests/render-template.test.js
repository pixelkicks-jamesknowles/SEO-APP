import { renderTemplate } from "../app/lib/apply-seo.server.js";

const ctx = {
  "product.title": "Air Max",
  "product.type": "Shoes",
  "product.vendor": "Nike",
  "shop.name": "Kicks",
};

describe("renderTemplate", () => {
  test("substitutes known tokens", () => {
    expect(renderTemplate("{{ product.title }} — {{ product.type }} | {{ shop.name }}", ctx)).toBe(
      "Air Max — Shoes | Kicks",
    );
  });

  test("unknown tokens render empty and whitespace collapses", () => {
    expect(renderTemplate("{{ product.title }} {{ missing }} end", ctx)).toBe("Air Max end");
  });

  test("empty / undefined template → empty string", () => {
    expect(renderTemplate("", ctx)).toBe("");
    expect(renderTemplate(undefined, ctx)).toBe("");
  });

  test("trims surrounding whitespace", () => {
    expect(renderTemplate("  {{ shop.name }}  ", ctx)).toBe("Kicks");
  });
});
