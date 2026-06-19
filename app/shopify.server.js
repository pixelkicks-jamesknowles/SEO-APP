import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
// Plan catalogue (spec seo-app-v1 §9) — client-safe constant lives in ./lib/plans so routes can
// import it. Pro unlocks server-side tracking + programmatic pages. Requires the Billing API
// (not Shopify "managed pricing") in the Partner dashboard.
import { PLAN } from "./lib/plans";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  // Explicit Admin API version (required by this SDK). April26 ("2026-04") is the newest
  // member in the installed @shopify/shopify-api and matches the webhook version pinned in
  // shopify.app.toml.
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [PLAN.STARTER]: {
      lineItems: [{ amount: 15, currencyCode: "USD", interval: BillingInterval.Every30Days }],
    },
    [PLAN.GROWTH]: {
      lineItems: [{ amount: 39, currencyCode: "USD", interval: BillingInterval.Every30Days }],
    },
    [PLAN.PRO]: {
      lineItems: [{ amount: 79, currencyCode: "USD", interval: BillingInterval.Every30Days }],
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
    // Required for new public apps (Shopify, since 2026-04-01): offline tokens
    // expire; the library auto-refreshes on unauthenticated.admin / webhook /
    // appProxy. Never persist session.accessToken in an app table.
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
