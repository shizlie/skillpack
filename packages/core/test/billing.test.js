import { expect, test } from "bun:test";

import { generateEd25519KeyPair } from "@skillpack/crypto";
import {
  createDodoPaymentProvider,
  createLicenseFetchHandler,
  createPaymentProviderRegistry,
  createStripePaymentProvider,
} from "../src/index.js";
import { createSqliteLeaseStore } from "../src/storage-sqlite.js";

function makeHandler(overrides = {}) {
  const keys = generateEd25519KeyPair();
  return createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: "mgmt-key",
    ...overrides,
  });
}

async function seedUsage(fetch) {
  const headers = { "content-type": "application/json", "x-api-key": "mgmt-key" };
  await fetch(
    new Request("http://local/v1/providers", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: "prov-1", name: "Provider One" }),
    })
  );
  await fetch(
    new Request("http://local/v1/providers/prov-1/customers", {
      method: "POST",
      headers,
      body: JSON.stringify({ customerId: "cust-1", name: "Customer One" }),
    })
  );
  await fetch(
    new Request("http://local/v1/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "ws-1",
        providerId: "prov-1",
        customerId: "cust-1",
      }),
    })
  );
  await fetch(
    new Request("http://local/v1/meter/upload", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "ws-1",
        context: {
          providerId: "prov-1",
          customerId: "cust-1",
          skillId: "laws-consultant",
          bundleId: "laws-consultant-1.0.0",
          leaseJti: "lease-1",
          policyId: "policy-1",
        },
        events: [
          {
            prevHash: "GENESIS",
            seq: 0,
            at: 1_800_000_100,
            kind: "tool_call",
            seatId: "seat-1",
            tool: "wiki_search",
            usage: { unit: "tool_call", delta: 3 },
          },
          {
            prevHash: "h1",
            seq: 1,
            at: 1_800_000_200,
            kind: "tool_call",
            seatId: "seat-1",
            tool: "wiki_read_page",
            usage: { unit: "tool_call", delta: 2 },
          },
        ],
      }),
    })
  );
}

test("billing api: pricing rules rate accepted usage into a draft invoice", async () => {
  const fetch = makeHandler({ leaseStore: createSqliteLeaseStore() });
  const headers = { "content-type": "application/json", "x-api-key": "mgmt-key" };
  await seedUsage(fetch);

  const ruleRes = await fetch(
    new Request("http://local/v1/billing/pricing-rules", {
      method: "POST",
      headers,
      body: JSON.stringify({
        pricingRuleId: "price-search",
        providerId: "prov-1",
        customerId: "cust-1",
        workspaceId: "ws-1",
        skillId: "laws-consultant",
        tool: "wiki_search",
        currency: "usd",
        unitAmountCents: 25,
        includedUnits: 1,
        paymentProvider: { provider: "dodo", productId: "prod_search" },
      }),
    })
  );
  expect(ruleRes.status).toBe(200);
  expect((await ruleRes.json()).pricingRule.pricingRuleId).toBe("price-search");

  await fetch(
    new Request("http://local/v1/billing/pricing-rules", {
      method: "POST",
      headers,
      body: JSON.stringify({
        pricingRuleId: "price-default",
        providerId: "prov-1",
        customerId: "cust-1",
        currency: "usd",
        unitAmountCents: 10,
      }),
    })
  );

  const invoiceRes = await fetch(
    new Request("http://local/v1/billing/invoices/draft", {
      method: "POST",
      headers,
      body: JSON.stringify({
        invoiceId: "inv-1",
        providerId: "prov-1",
        customerId: "cust-1",
        workspaceId: "ws-1",
        periodStartSec: 1_800_000_000,
        periodEndSec: 1_800_001_000,
      }),
    })
  );

  expect(invoiceRes.status).toBe(200);
  const body = await invoiceRes.json();
  expect(body.invoice).toMatchObject({
    invoiceId: "inv-1",
    providerId: "prov-1",
    customerId: "cust-1",
    workspaceId: "ws-1",
    status: "DRAFT",
    currency: "USD",
    subtotalAmountCents: 70,
    totalAmountCents: 70,
  });
  expect(body.invoice.lines).toEqual([
    expect.objectContaining({
      pricingRuleId: "price-default",
      tool: "wiki_read_page",
      quantity: 2,
      billableQuantity: 2,
      unitAmountCents: 10,
      amountCents: 20,
    }),
    expect.objectContaining({
      pricingRuleId: "price-search",
      tool: "wiki_search",
      quantity: 3,
      billableQuantity: 2,
      unitAmountCents: 25,
      amountCents: 50,
    }),
  ]);
});

test("billing api: manual handoff keeps money exchange outside skillpack", async () => {
  const fetch = makeHandler({ leaseStore: createSqliteLeaseStore() });
  const headers = { "content-type": "application/json", "x-api-key": "mgmt-key" };
  await seedUsage(fetch);
  await fetch(
    new Request("http://local/v1/billing/pricing-rules", {
      method: "POST",
      headers,
      body: JSON.stringify({
        pricingRuleId: "price-default",
        providerId: "prov-1",
        customerId: "cust-1",
        currency: "USD",
        unitAmountCents: 100,
      }),
    })
  );
  await fetch(
    new Request("http://local/v1/billing/invoices/draft", {
      method: "POST",
      headers,
      body: JSON.stringify({
        invoiceId: "inv-manual",
        providerId: "prov-1",
        customerId: "cust-1",
        periodStartSec: 1_800_000_000,
        periodEndSec: 1_800_001_000,
      }),
    })
  );

  const handoffRes = await fetch(
    new Request("http://local/v1/billing/invoices/inv-manual/payment-handoff", {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "manual", metadata: { po: "PO-1" } }),
    })
  );

  expect(handoffRes.status).toBe(200);
  expect(await handoffRes.json()).toEqual({
    accepted: true,
    paymentHandoff: {
      invoiceId: "inv-manual",
      provider: "manual",
      status: "manual_required",
      checkoutUrl: null,
      externalId: null,
      providerRequest: null,
      providerResponse: null,
      metadata: { po: "PO-1" },
    },
  });
});

test("billing api: dodo provider creates checkout session from invoice lines", async () => {
  const calls = [];
  const registry = createPaymentProviderRegistry({
    providers: [
      createDodoPaymentProvider({
        apiKey: "dodo-key",
        environment: "test",
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return new Response(
            JSON.stringify({
              session_id: "cs_123",
              checkout_url: "https://checkout.dodopayments.com/cs_123",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        },
      }),
    ],
  });
  const fetch = makeHandler({
    leaseStore: createSqliteLeaseStore(),
    paymentProviders: registry,
  });
  const headers = { "content-type": "application/json", "x-api-key": "mgmt-key" };
  await seedUsage(fetch);
  await fetch(
    new Request("http://local/v1/billing/pricing-rules", {
      method: "POST",
      headers,
      body: JSON.stringify({
        pricingRuleId: "price-search",
        providerId: "prov-1",
        customerId: "cust-1",
        tool: "wiki_search",
        currency: "USD",
        unitAmountCents: 100,
        paymentProvider: { provider: "dodo", productId: "prod_search" },
      }),
    })
  );
  await fetch(
    new Request("http://local/v1/billing/pricing-rules", {
      method: "POST",
      headers,
      body: JSON.stringify({
        pricingRuleId: "price-default",
        providerId: "prov-1",
        customerId: "cust-1",
        currency: "USD",
        unitAmountCents: 50,
        paymentProvider: { provider: "dodo", productId: "prod_default" },
      }),
    })
  );
  await fetch(
    new Request("http://local/v1/billing/invoices/draft", {
      method: "POST",
      headers,
      body: JSON.stringify({
        invoiceId: "inv-dodo",
        providerId: "prov-1",
        customerId: "cust-1",
        periodStartSec: 1_800_000_000,
        periodEndSec: 1_800_001_000,
      }),
    })
  );

  const handoffRes = await fetch(
    new Request("http://local/v1/billing/invoices/inv-dodo/payment-handoff", {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "dodo",
        returnUrl: "https://vendor.example/paid",
        customer: { email: "ops@example.com", name: "Ops Lead" },
      }),
    })
  );

  expect(handoffRes.status).toBe(200);
  const body = await handoffRes.json();
  expect(body.paymentHandoff).toMatchObject({
    invoiceId: "inv-dodo",
    provider: "dodo",
    status: "checkout_created",
    checkoutUrl: "https://checkout.dodopayments.com/cs_123",
    externalId: "cs_123",
  });
  expect(calls[0].url).toBe("https://test.dodopayments.com/checkouts");
  expect(JSON.parse(calls[0].init.body)).toMatchObject({
    product_cart: [
      { product_id: "prod_default", quantity: 2 },
      { product_id: "prod_search", quantity: 3 },
    ],
    customer: { email: "ops@example.com", name: "Ops Lead" },
    return_url: "https://vendor.example/paid",
    metadata: {
      skillpack_invoice_id: "inv-dodo",
      skillpack_provider_id: "prov-1",
      skillpack_customer_id: "cust-1",
    },
  });
});

test("billing provider: stripe adapter creates checkout session from price ids", async () => {
  const calls = [];
  const provider = createStripePaymentProvider({
    apiKey: "stripe-key",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          id: "cs_stripe_123",
          url: "https://checkout.stripe.com/c/pay/cs_stripe_123",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  const handoff = await provider.createPaymentHandoff({
    invoice: {
      invoiceId: "inv-stripe",
      providerId: "prov-1",
      customerId: "cust-1",
      lines: [
        {
          amountCents: 400,
          billableQuantity: 4,
          paymentProvider: { provider: "stripe", priceId: "price_123" },
        },
      ],
    },
    request: {
      provider: "stripe",
      returnUrl: "https://vendor.example/paid",
      metadata: {},
    },
  });

  expect(handoff).toMatchObject({
    invoiceId: "inv-stripe",
    provider: "stripe",
    status: "checkout_created",
    checkoutUrl: "https://checkout.stripe.com/c/pay/cs_stripe_123",
    externalId: "cs_stripe_123",
  });
  expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
  expect(calls[0].init.body.toString()).toContain("line_items%5B0%5D%5Bprice%5D=price_123");
});

test("billing provider: dodo skips zero-amount lines instead of forcing a minimum quantity", async () => {
  const calls = [];
  const provider = createDodoPaymentProvider({
    apiKey: "dodo-key",
    environment: "test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          session_id: "cs_123",
          checkout_url: "https://checkout.dodopayments.com/cs_123",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  await provider.createPaymentHandoff({
    invoice: {
      invoiceId: "inv-zero-dodo",
      providerId: "prov-1",
      customerId: "cust-1",
      lines: [
        {
          amountCents: 0,
          billableQuantity: 0,
          paymentProvider: { provider: "dodo", productId: "prod_included" },
        },
        {
          amountCents: 100,
          billableQuantity: 2,
          paymentProvider: { provider: "dodo", productId: "prod_billable" },
        },
      ],
    },
    request: { provider: "dodo", metadata: {} },
  });

  expect(JSON.parse(calls[0].init.body).product_cart).toEqual([
    { product_id: "prod_billable", quantity: 2 },
  ]);
});

test("billing provider: dodo keeps minimum-charge lines with a checkout quantity of one", async () => {
  const calls = [];
  const provider = createDodoPaymentProvider({
    apiKey: "dodo-key",
    environment: "test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          session_id: "cs_123",
          checkout_url: "https://checkout.dodopayments.com/cs_123",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  await provider.createPaymentHandoff({
    invoice: {
      invoiceId: "inv-minimum-dodo",
      providerId: "prov-1",
      customerId: "cust-1",
      lines: [
        {
          amountCents: 500,
          billableQuantity: 0,
          paymentProvider: { provider: "dodo", productId: "prod_minimum" },
        },
      ],
    },
    request: { provider: "dodo", metadata: {} },
  });

  expect(JSON.parse(calls[0].init.body).product_cart).toEqual([
    { product_id: "prod_minimum", quantity: 1 },
  ]);
});

test("billing provider: stripe refuses checkout when invoice has no payable lines", async () => {
  const provider = createStripePaymentProvider({
    apiKey: "stripe-key",
    fetchImpl: async () => {
      throw new Error("should_not_call_stripe_for_zero_invoice");
    },
  });

  await expect(
    provider.createPaymentHandoff({
      invoice: {
        invoiceId: "inv-zero-stripe",
        providerId: "prov-1",
        customerId: "cust-1",
        lines: [
          {
            amountCents: 0,
            billableQuantity: 0,
            paymentProvider: { provider: "stripe", priceId: "price_included" },
          },
        ],
      },
      request: { provider: "stripe", metadata: {} },
    })
  ).rejects.toThrow(/invoice_has_no_payable_lines/);
});
test("GET /v1/billing/invoices/:id returns the drafted invoice", async () => {
  const fetch = makeHandler({ leaseStore: createSqliteLeaseStore() });
  const headers = { "content-type": "application/json", "x-api-key": "mgmt-key" };

  // Draft an invoice (no usage/pricing rules needed — empty invoice is fine)
  const draftRes = await fetch(
    new Request("http://local/v1/billing/invoices/draft", {
      method: "POST",
      headers,
      body: JSON.stringify({
        invoiceId: "inv-get-test",
        providerId: "prov-1",
        customerId: "cust-1",
        periodStartSec: 1_800_000_000,
        periodEndSec: 1_800_001_000,
      }),
    })
  );
  expect(draftRes.status).toBe(200);
  const { invoice: drafted } = await draftRes.json();
  expect(drafted.invoiceId).toBe("inv-get-test");

  // GET /v1/billing/invoices/:id — returns the same invoice
  const getRes = await fetch(
    new Request("http://local/v1/billing/invoices/inv-get-test", {
      method: "GET",
      headers,
    })
  );
  expect(getRes.status).toBe(200);
  const { invoice } = await getRes.json();
  expect(invoice.invoiceId).toBe("inv-get-test");
  expect(invoice.providerId).toBe("prov-1");
  expect(invoice.customerId).toBe("cust-1");

  // GET with a nonexistent id — 404
  const notFoundRes = await fetch(
    new Request("http://local/v1/billing/invoices/inv-does-not-exist", {
      method: "GET",
      headers,
    })
  );
  expect(notFoundRes.status).toBe(404);
  expect((await notFoundRes.json()).error).toBe("invoice_not_found");
});
