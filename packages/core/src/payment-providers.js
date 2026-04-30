function normalizeEnvironmentBaseUrl(environment) {
  if (environment === "test" || environment === "test_mode") {
    return "https://test.dodopayments.com";
  }
  return "https://live.dodopayments.com";
}

function payableInvoiceLines(invoice) {
  return (invoice.lines ?? []).filter((line) => Number(line.amountCents) > 0);
}

function checkoutQuantity(line) {
  const billableQuantity = Number(line.billableQuantity);
  if (Number.isFinite(billableQuantity) && billableQuantity > 0) {
    return Math.ceil(billableQuantity);
  }
  return 1;
}

export function createManualPaymentProvider() {
  return {
    name: "manual",
    async createPaymentHandoff({ invoice, request }) {
      return {
        invoiceId: invoice.invoiceId,
        provider: "manual",
        status: "manual_required",
        checkoutUrl: null,
        externalId: null,
        providerRequest: null,
        providerResponse: null,
        metadata: request.metadata ?? {},
      };
    },
  };
}

export function createDodoPaymentProvider({
  apiKey,
  environment = "live",
  baseUrl = normalizeEnvironmentBaseUrl(environment),
  fetchImpl = fetch,
} = {}) {
  return {
    name: "dodo",
    async createPaymentHandoff({ invoice, request }) {
      if (!apiKey) throw new Error("dodo_missing_api_key");
      const productCart = [];
      for (const line of payableInvoiceLines(invoice)) {
        const productId = line.paymentProvider?.productId;
        if (!productId) throw new Error("dodo_missing_product_id");
        productCart.push({
          product_id: productId,
          quantity: checkoutQuantity(line),
        });
      }
      if (productCart.length === 0) throw new Error("invoice_has_no_payable_lines");

      const providerRequest = {
        product_cart: productCart,
        ...(request.customer ? { customer: request.customer } : {}),
        ...(request.returnUrl ? { return_url: request.returnUrl } : {}),
        metadata: {
          ...(request.metadata ?? {}),
          skillpack_invoice_id: invoice.invoiceId,
          skillpack_provider_id: invoice.providerId,
          skillpack_customer_id: invoice.customerId,
        },
      };

      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/checkouts`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(providerRequest),
      });
      const providerResponse = await response.json();
      if (!response.ok) {
        throw new Error(`dodo_checkout_failed:${response.status}`);
      }
      return {
        invoiceId: invoice.invoiceId,
        provider: "dodo",
        status: "checkout_created",
        checkoutUrl: providerResponse.checkout_url ?? null,
        externalId: providerResponse.session_id ?? null,
        providerRequest,
        providerResponse,
        metadata: request.metadata ?? {},
      };
    },
  };
}

export function createStripePaymentProvider({
  apiKey,
  baseUrl = "https://api.stripe.com",
  fetchImpl = fetch,
} = {}) {
  return {
    name: "stripe",
    async createPaymentHandoff({ invoice, request }) {
      if (!apiKey) throw new Error("stripe_missing_api_key");
      const body = new URLSearchParams();
      body.set("mode", "payment");
      if (request.returnUrl) {
        body.set("success_url", request.returnUrl);
        body.set("cancel_url", request.returnUrl);
      }
      body.set("metadata[skillpack_invoice_id]", invoice.invoiceId);
      body.set("metadata[skillpack_provider_id]", invoice.providerId);
      body.set("metadata[skillpack_customer_id]", invoice.customerId);
      for (const [key, value] of Object.entries(request.metadata ?? {})) {
        body.set(`metadata[${key}]`, String(value));
      }
      const payableLines = payableInvoiceLines(invoice);
      for (const [index, line] of payableLines.entries()) {
        const priceId = line.paymentProvider?.priceId;
        if (!priceId) throw new Error("stripe_missing_price_id");
        body.set(`line_items[${index}][price]`, priceId);
        body.set(`line_items[${index}][quantity]`, String(checkoutQuantity(line)));
      }
      if (payableLines.length === 0) throw new Error("invoice_has_no_payable_lines");
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/checkout/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
      const providerResponse = await response.json();
      if (!response.ok) {
        throw new Error(`stripe_checkout_failed:${response.status}`);
      }
      return {
        invoiceId: invoice.invoiceId,
        provider: "stripe",
        status: "checkout_created",
        checkoutUrl: providerResponse.url ?? null,
        externalId: providerResponse.id ?? null,
        providerRequest: Object.fromEntries(body.entries()),
        providerResponse,
        metadata: request.metadata ?? {},
      };
    },
  };
}

export function createPaymentProviderRegistry({ providers = [] } = {}) {
  const providerMap = new Map();
  const manual = createManualPaymentProvider();
  providerMap.set(manual.name, manual);
  for (const provider of providers) {
    providerMap.set(provider.name, provider);
  }
  return {
    get(providerName = "manual") {
      return providerMap.get(providerName) ?? null;
    },
  };
}
