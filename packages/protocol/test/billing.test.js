import { expect, test } from "bun:test";

import {
  validateInvoiceDraftRequestContract,
  validatePaymentHandoffRequestContract,
  validatePricingRuleContract,
} from "../src/index.js";

test("billing contracts: pricing rule defaults to active tool-call usage rating", () => {
  const rule = validatePricingRuleContract({
    pricingRuleId: "price-1",
    providerId: "prov-1",
    customerId: "cust-1",
    workspaceId: "ws-1",
    skillId: "laws-consultant",
    tool: "wiki_search",
    unitAmountCents: 25,
    currency: "usd",
    paymentProvider: {
      provider: "dodo",
      productId: "prod_laws_search",
    },
  });

  expect(rule).toEqual({
    pricingRuleId: "price-1",
    providerId: "prov-1",
    customerId: "cust-1",
    workspaceId: "ws-1",
    skillId: "laws-consultant",
    bundleId: null,
    tool: "wiki_search",
    unit: "tool_call",
    currency: "USD",
    unitAmountCents: 25,
    includedUnits: 0,
    minimumAmountCents: 0,
    status: "ACTIVE",
    paymentProvider: {
      provider: "dodo",
      productId: "prod_laws_search",
      priceId: null,
      metadata: {},
    },
  });
});

test("billing contracts: draft request requires a valid provider/customer period", () => {
  const request = validateInvoiceDraftRequestContract({
    providerId: "prov-1",
    customerId: "cust-1",
    workspaceId: "ws-1",
    periodStartSec: 1_800_000_000,
    periodEndSec: 1_800_086_400,
    invoiceId: "inv-custom",
  });

  expect(request).toEqual({
    providerId: "prov-1",
    customerId: "cust-1",
    workspaceId: "ws-1",
    periodStartSec: 1_800_000_000,
    periodEndSec: 1_800_086_400,
    invoiceId: "inv-custom",
    currency: null,
  });

  expect(() =>
    validateInvoiceDraftRequestContract({
      providerId: "prov-1",
      customerId: "cust-1",
      periodStartSec: 10,
      periodEndSec: 10,
    })
  ).toThrow(/invoice_period_invalid/);
});

test("billing contracts: payment handoff supports manual and provider checkout adapters", () => {
  const handoff = validatePaymentHandoffRequestContract({
    provider: "dodo",
    returnUrl: "https://vendor.example/paid",
    customer: { email: "ops@example.com", name: "Ops Lead" },
    metadata: { source: "billing-test" },
  });

  expect(handoff).toEqual({
    provider: "dodo",
    returnUrl: "https://vendor.example/paid",
    customer: { email: "ops@example.com", name: "Ops Lead" },
    metadata: { source: "billing-test" },
  });

  expect(validatePaymentHandoffRequestContract({})).toEqual({
    provider: "manual",
    returnUrl: null,
    customer: null,
    metadata: {},
  });
});
