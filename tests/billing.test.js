import { PRO_PLAN, billingConfig, hasProAccess, requirePro } from "../app/lib/billing.server.js";

test("the Pro plan is defined for shopifyApp({ billing }) but priced sanely", () => {
  expect(billingConfig[PRO_PLAN]).toBeDefined();
  expect(billingConfig[PRO_PLAN].lineItems[0].amount).toBeGreaterThan(0);
  expect(billingConfig[PRO_PLAN].trialDays).toBeGreaterThan(0);
});

test("hasProAccess grants unlimited access while billing is unenforced (app stays free)", async () => {
  const access = await hasProAccess({ check: jest.fn() });
  expect(access).toMatchObject({ active: true, enforced: false });
});

test("requirePro is a no-op while unenforced — never calls the Billing API", async () => {
  const billing = { require: jest.fn(), request: jest.fn() };
  await requirePro(billing);
  expect(billing.require).not.toHaveBeenCalled();
});
