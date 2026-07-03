module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  // Coverage ratchet: floors sit just under the current numbers (stmts ~84.5 / branch ~74.2 / funcs
  // ~73.5 / lines ~88) so coverage can't silently regress. Raise these as coverage climbs; never lower
  // them. Enforced in CI via `npm run test:coverage`.
  coverageThreshold: {
    global: { statements: 83, branches: 73, functions: 73, lines: 87 },
  },
};
