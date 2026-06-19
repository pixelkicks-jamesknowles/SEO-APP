import { parseCsvRedirects } from "../app/lib/csv-redirects.server.js";

describe("parseCsvRedirects", () => {
  test("parses from,to pairs", () => {
    expect(parseCsvRedirects("/old,/new\n/a,/b")).toEqual([
      { from: "/old", to: "/new" },
      { from: "/a", to: "/b" },
    ]);
  });

  test("skips blanks, a header row, and non-path froms", () => {
    const csv = "from,to\n\n/old, /new \nnot-a-path,/x\n/keep,/yes";
    expect(parseCsvRedirects(csv)).toEqual([
      { from: "/old", to: "/new" },
      { from: "/keep", to: "/yes" },
    ]);
  });

  test("trims whitespace and handles empty input", () => {
    expect(parseCsvRedirects("")).toEqual([]);
    expect(parseCsvRedirects(undefined)).toEqual([]);
  });
});
