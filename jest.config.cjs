module.exports = {
  // node by default (the suite mocks Prisma + fetch and needs no DOM). Component tests opt in per-file
  // with an `@jest-environment jsdom` docblock, so the fast node tests aren't slowed by a DOM they
  // don't use.
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js", "**/tests/**/*.test.jsx"],
  moduleFileExtensions: ["js", "jsx", "json"],
  // Polaris ships CSS its components import; jest can't parse that and it's irrelevant to behaviour.
  moduleNameMapper: { "\\.(css|scss)$": "<rootDir>/tests/helpers/style-stub.js" },
  // Applies to every environment but only does anything under jsdom (it guards on `window`).
  setupFiles: ["<rootDir>/tests/helpers/jsdom-setup.js"],
  // Coverage ratchet: floors sit just under the current numbers (stmts ~87.2 / branch ~77.0 / funcs
  // ~76.3 / lines ~90.3) so coverage can't silently regress. Raise these as coverage climbs; never lower
  // them. Enforced in CI via `npm run test:coverage`.
  coverageThreshold: {
    global: { statements: 86, branches: 76, functions: 75, lines: 89 },
  },
};
