import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { assertEncryptionKey } from "./lib/secrets.server";
import { billingConfig } from "./lib/billing.server";

// Surface credential-encryption-key misconfiguration at boot (warns; never throws).
assertEncryptionKey();

// Free app today. The Pro plan is DEFINED here (so Shopify knows it exists) but NOT enforced — no route
// calls billing.require until a pricing decision is made. See lib/billing.server.js (BILLING_ENFORCED).
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  // Explicit Admin API version (required by this SDK). April26 ("2026-04") matches the webhook
  // version pinned in shopify.app.toml.
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: billingConfig,
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
