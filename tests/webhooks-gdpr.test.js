/* eslint-disable import/first -- jest.mock() must be declared above the imports it intercepts */
// Integration tests for the three mandatory GDPR webhooks. These verify the compliance behaviour is
// GENUINE (real deletes / a real no-op), not just a 200 stub — the exact thing a Shopify app reviewer
// checks. HMAC is owned by authenticate.webhook (mocked).
jest.mock("../app/shopify.server.js", () => ({ __esModule: true, authenticate: { webhook: jest.fn() } }));
jest.mock("../app/db.server.js", () => ({ __esModule: true, default: require("./helpers/prisma-mock").makePrismaMock() }));

import prisma from "../app/db.server.js";
import { authenticate } from "../app/shopify.server.js";
import { sha256Hex } from "../app/lib/server-side.server.js";
import { linkIdentity } from "../app/lib/identity.server.js";
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

  test("purges VisitorAttribution via the visitor keys in VisitorIdentity (durableId AND clientId)", async () => {
    // VisitorAttribution is keyed on the VISITOR KEY (visitorKey() = durableId || clientId), so a given
    // customer's rows may be filed under EITHER. Both identifiers from each identity row must therefore be
    // used as selectors, or the rows filed under the other one survive the erasure.
    prisma.visitorIdentity.findMany.mockResolvedValue([
      { durableId: "pxp_abc", clientId: "111.222" },
      { durableId: "pxp_def", clientId: null },
    ]);
    authenticate.webhook.mockResolvedValue({ shop: SHOP, topic: "customers/redact", payload: { customer: { id: 123, email: "a@b.com" } } });

    await customersRedact(req);

    // Resolved from the identity graph, keyed on customerKey — NOT from CustomerAttribution, whose
    // `clientId` column was never written by any code path (see the drop migration).
    const lookup = prisma.visitorIdentity.findMany.mock.calls[0][0];
    expect(lookup.where.customerKey.in).toEqual(["123", "e:" + sha256Hex("a@b.com")]);

    expect(prisma.visitorAttribution.deleteMany).toHaveBeenCalledWith({
      where: { shopDomain: SHOP, clientId: { in: ["pxp_abc", "111.222", "pxp_def"] } },
    });
    // The mapping row itself is still deleted afterwards.
    expect(prisma.customerAttribution.deleteMany).toHaveBeenCalledTimes(1);
  });

  test("deletes the VisitorIdentity rows themselves (durableId <-> clientId <-> customerKey)", async () => {
    // The graph row is not just a lookup table: its customerKey can be the RAW Shopify customer id, so
    // leaving it behind keeps a directly-identifying link to the visitor's browser identifiers. Nothing
    // TTL-purges this table, so a miss here persists until the shop uninstalls.
    authenticate.webhook.mockResolvedValue({ shop: SHOP, topic: "customers/redact", payload: { customer: { id: 123, email: "a@b.com" } } });
    await customersRedact(req);
    expect(prisma.visitorIdentity.deleteMany).toHaveBeenCalledWith({
      where: { shopDomain: SHOP, customerKey: { in: ["123", "e:" + sha256Hex("a@b.com")] } },
    });
  });

  test("no identity rows → nothing to purge from VisitorAttribution", async () => {
    prisma.visitorIdentity.findMany.mockResolvedValue([]);
    authenticate.webhook.mockResolvedValue({ shop: SHOP, topic: "customers/redact", payload: { customer: { id: 123 } } });
    await customersRedact(req);
    expect(prisma.visitorAttribution.deleteMany).not.toHaveBeenCalled();
    // The identity table is still swept by customerKey even when the lookup found nothing to resolve.
    expect(prisma.visitorIdentity.deleteMany).toHaveBeenCalled();
  });

  // REGRESSION GUARD for the bug this file previously hid. The old test mocked
  // `CustomerAttribution.clientId` to "111.222" and asserted the purge ran — but NO code path ever wrote
  // that column, so in production it was always NULL, the purge was always skipped, and the test passed
  // against a premise the system could not produce.
  //
  // The fix is not just "mock a different table": it is to tie the READER to the WRITER, so the lookup
  // field can never again drift away from what production actually populates. This calls the real
  // linkIdentity() and asserts the field it writes is the same field customers/redact queries on.
  test("the field customers/redact looks up is one linkIdentity actually writes", async () => {
    await linkIdentity(SHOP, { durableId: "pxp_abc", clientId: "111.222", customerKey: "123" });

    const written = prisma.visitorIdentity.upsert.mock.calls[0][0];
    expect(written.create.customerKey).toBe("123");
    expect(written.create.clientId).toBe("111.222");
    expect(written.create.durableId).toBe("pxp_abc");

    jest.clearAllMocks();
    authenticate.webhook.mockResolvedValue({ shop: SHOP, topic: "customers/redact", payload: { customer: { id: 123 } } });
    await customersRedact(req);

    // Same model, same field, and the selectors it reads back are the ones linkIdentity populates.
    const lookup = prisma.visitorIdentity.findMany.mock.calls[0][0];
    expect(Object.keys(lookup.where)).toContain("customerKey");
    expect(Object.keys(lookup.select).sort()).toEqual(["clientId", "durableId"]);
  });

  test("purges the customer-keyed lifetime + order-keyed path/unattributed rows", async () => {
    authenticate.webhook.mockResolvedValue({
      shop: SHOP,
      topic: "customers/redact",
      payload: { customer: { id: 123, email: "a@b.com" }, orders_to_redact: [111, 222] },
    });
    await customersRedact(req);
    // Per-customer lifetime is keyed like CustomerAttribution (id + hashed email).
    const ltWhere = prisma.customerLifetime.deleteMany.mock.calls[0][0].where;
    expect(ltWhere.customerKey.in).toEqual(["123", "e:" + sha256Hex("a@b.com")]);
    // Order-keyed conversion paths for the redacted orders.
    expect(prisma.conversionPath.deleteMany).toHaveBeenCalledWith({ where: { shopDomain: SHOP, orderId: { in: ["111", "222"] } } });
    // UnattributedOrder purged by either order id OR customer key.
    const uaWhere = prisma.unattributedOrder.deleteMany.mock.calls[0][0].where;
    expect(uaWhere.OR).toEqual([{ orderId: { in: ["111", "222"] } }, { customerKey: { in: ["123", "e:" + sha256Hex("a@b.com")] } }]);
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
      "trackingSettings",
      "activityLog",
      "recentEvent",
      "deliveryLog",
      "deliveryOutbox",
      "trackingDaily",
      "matchQualityDaily",
      "pendingPurchase",
      "pendingSubscription",
      "purchaseCapture",
      "processedWebhook",
      "customerAttribution",
      "customerLifetime",
      "visitorAttribution",
      "visitorIdentity",
      "channelRevenueDaily",
      "unattributedOrder",
      "conversionPath",
      "backfillJob",
      "connectionCheck",
      "alertDismissal",
      "alertNotification",
      "googleToken",
      "shop",
    ];
    for (const model of byShopDomain) {
      expect(prisma[model].deleteMany).toHaveBeenCalledWith({ where: { shopDomain: SHOP } });
    }
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });
});
