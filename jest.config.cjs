module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  // Coverage ratchet: floors sit just under the current numbers (stmts ~82.3 / branch ~73 / funcs ~73 /
  // lines ~85.6) so coverage can't silently regress. Raise these as coverage climbs; never lower them.
  // Enforced in CI via `npm run test:coverage`.
  coverageThreshold: {
    global: { statements: 81, branches: 72, functions: 73, lines: 84 },
  },
};
