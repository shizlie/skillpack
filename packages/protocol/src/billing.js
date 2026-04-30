import { z } from "zod";

const nonEmptyString = z.string().min(1);
const optionalNonEmptyString = z.string().min(1).optional();
const nullableOptionalString = z.string().min(1).nullable().optional();

const paymentProviderSchema = z
  .object({
    provider: nonEmptyString,
    productId: nullableOptionalString,
    priceId: nullableOptionalString,
    metadata: z.record(z.any()).optional(),
  })
  .strict();

export const pricingRuleSchema = z
  .object({
    pricingRuleId: nonEmptyString,
    providerId: nonEmptyString,
    customerId: nullableOptionalString,
    workspaceId: nullableOptionalString,
    skillId: nullableOptionalString,
    bundleId: nullableOptionalString,
    tool: nullableOptionalString,
    unit: z.literal("tool_call").optional(),
    currency: nonEmptyString,
    unitAmountCents: z.number().int().nonnegative(),
    includedUnits: z.number().finite().nonnegative().optional(),
    minimumAmountCents: z.number().int().nonnegative().optional(),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
    paymentProvider: paymentProviderSchema.nullable().optional(),
  })
  .strict();

export const invoiceDraftRequestSchema = z
  .object({
    invoiceId: optionalNonEmptyString,
    providerId: nonEmptyString,
    customerId: nonEmptyString,
    workspaceId: nullableOptionalString,
    periodStartSec: z.number().int().positive(),
    periodEndSec: z.number().int().positive(),
    currency: nullableOptionalString,
  })
  .strict();

export const paymentHandoffRequestSchema = z
  .object({
    provider: nonEmptyString.optional(),
    returnUrl: nullableOptionalString,
    customer: z
      .object({
        email: optionalNonEmptyString,
        name: optionalNonEmptyString,
      })
      .strict()
      .nullable()
      .optional(),
    metadata: z.record(z.any()).optional(),
  })
  .strict();

export function validatePricingRuleContract(input) {
  const parsed = pricingRuleSchema.safeParse(input);
  if (!parsed.success) throw new Error("pricing_rule_invalid_contract");
  return {
    pricingRuleId: parsed.data.pricingRuleId,
    providerId: parsed.data.providerId,
    customerId: parsed.data.customerId ?? null,
    workspaceId: parsed.data.workspaceId ?? null,
    skillId: parsed.data.skillId ?? null,
    bundleId: parsed.data.bundleId ?? null,
    tool: parsed.data.tool ?? null,
    unit: parsed.data.unit ?? "tool_call",
    currency: parsed.data.currency.toUpperCase(),
    unitAmountCents: parsed.data.unitAmountCents,
    includedUnits: parsed.data.includedUnits ?? 0,
    minimumAmountCents: parsed.data.minimumAmountCents ?? 0,
    status: parsed.data.status ?? "ACTIVE",
    paymentProvider: parsed.data.paymentProvider
      ? {
          provider: parsed.data.paymentProvider.provider,
          productId: parsed.data.paymentProvider.productId ?? null,
          priceId: parsed.data.paymentProvider.priceId ?? null,
          metadata: parsed.data.paymentProvider.metadata ?? {},
        }
      : null,
  };
}

export function validateInvoiceDraftRequestContract(input) {
  const parsed = invoiceDraftRequestSchema.safeParse(input);
  if (!parsed.success) throw new Error("invoice_draft_invalid_contract");
  if (parsed.data.periodEndSec <= parsed.data.periodStartSec) {
    throw new Error("invoice_period_invalid");
  }
  return {
    invoiceId: parsed.data.invoiceId,
    providerId: parsed.data.providerId,
    customerId: parsed.data.customerId,
    workspaceId: parsed.data.workspaceId ?? null,
    periodStartSec: parsed.data.periodStartSec,
    periodEndSec: parsed.data.periodEndSec,
    currency: parsed.data.currency ? parsed.data.currency.toUpperCase() : null,
  };
}

export function validatePaymentHandoffRequestContract(input) {
  const parsed = paymentHandoffRequestSchema.safeParse(input ?? {});
  if (!parsed.success) throw new Error("payment_handoff_invalid_contract");
  return {
    provider: parsed.data.provider ?? "manual",
    returnUrl: parsed.data.returnUrl ?? null,
    customer: parsed.data.customer ?? null,
    metadata: parsed.data.metadata ?? {},
  };
}
