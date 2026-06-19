// Client-safe plan keys. Kept out of shopify.server.js so route components can import it —
// a `*.server` module can't be imported into client-rendered code.
export const PLAN = { STARTER: "Starter", GROWTH: "Growth", PRO: "Pro" };
