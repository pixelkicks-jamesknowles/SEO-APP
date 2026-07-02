/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// Integration tests for the three mandatory GDPR webhooks. These verify the compliance behaviour is
// GENUINE (real deletes / a real no-op), not just a 200 stub — the exact thing a Shopify app reviewer
// checks. HMAC is owned by authenticate.webhook (mocked).
jest.mock("../app/shopify.server.js", () => ({ __esModule: true, authenticate: { webhook: jest.fn() } }));
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { authenticate } from "../app/shopify.server.js";
import { sha256Hex } from "../app/lib/server-side.server.js";
import { action as customersRedact } from "../app/routes/webhooks.customers.redact.jsx";
import { action as shopRedact } from "../app/routes/webhooks.shop.redact.jsx";
import { action as dataRequest } from "../app/routes/webhooks.customers.data_request.jsx";

const SHOP = "s.myshopify.com";
const req = { request: {} };

beforeEach(() => jest.clearAllMocks());

describe("customers/data_request", () => {
  test("acknowledges with a 200 and no data (the app stores no customer PII at rest)", async () => {
    authenticate.webhook.mockResolvedValue({ shop: SHOP, topic: "customers/data_request", payload: { customer: { id: 1 } } });
    const res = await dataRequest(req);
    expect(res.status).toBe(200);
    // No customer-linked table is read or written — there is nothing to return.
    expect(prisma.customerAttribution.findMany).not.toHaveBeenCalled();
    expect(prisma.customerAttribution.deleteMany).not.toHaveBeenCalled();
  });
});

describe("customers/redact", () => {
  test("deletes CustomerAttribution for BOTH candidate keys (customer id and hashed email)", async () => {
    const email = "shopper@example.com";
    authenticate.webhook.mockResolvedValue({ shop: SHOP, topic: "customers/redact", payload: { customer: { id: 123, email } } });

    await customersRedact(req);

    expect(prisma.customerAttribution.deleteMany).toHaveBeenCalledTimes(1);
    const where = prisma.customerAttribution.deleteMany.mock.calls[0][0].where;
    expect(where.shopDomain).toBe(SHOP);
    expect(where.customerKey.in).toEqual(["123", `e:${sha256Hex(email)}`]);
  });

  test("still deletes by id alone when no email is present", async () => {
    authenticate.webhook.mockResolvedValue({ shop: SHOP, topic: "customers/redact", payload: { customer: { id: 456 } } });
    await customersRedact(req);
    expect(prisma.customerAttribution.deleteMany.mock.calls[0][0].where.customerKey.in).toEqual(["456"]);
  });

  test("no identifiers at all → no delete attempted (nothing to redact)", async () => {
    authenticate.webhook.mockResolvedValue({ shop: SHOP, topic: "customers/redact", payload: {} });
    await customersRedact(req);
    expect(prisma.customerAttribution.deleteMany).not.toHaveBeenCalled();
  });
});

describe("shop/redact", () => {
  test("purges every shop-scoped table — including PII (attribution) and credentials (Google token)", async () => {
    authenticate.webhook.mockResolvedValue({ shop: SHOP, topic: "shop/redact" });

    await shopRedact(req);

    // Every table that holds shop data is wiped, keyed on the shop. This must include the tables that
    // hold personal data (CustomerAttribution = hashed emails, VisitorAttribution) and secrets
    // (GoogleToken) — leaving any of them behind is residual PII/credentials after a deletion request.
    const byShopDomain = [
      "seoSettings",
      "trackingSettings",
      "redirect404Log",
      "resourceHandle",
      "activityLog",
      "auditSnapshot",
      "recentEvent",
      "deliveryLog",
      "deliveryOutbox",
      "trackingDaily",
      "processedWebhook",
      "customerAttribution",
      "visitorAttribution",
      "alertDismissal",
      "googleToken",
      "shop",
    ];
    for (const model of byShopDomain) {
      expect(prisma[model].deleteMany).toHaveBeenCalledWith({ where: { shopDomain: SHOP } });
    }
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });
});
