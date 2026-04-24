import { z } from "zod";

const UNKNOWN_PROVIDER_ID = "provider:unknown";
const UNKNOWN_CUSTOMER_ID = "customer:unknown";
export const USAGE_UNIT_TOOL_CALL = "tool_call";
export const WORKSPACE_STATUS_ACTIVE = "ACTIVE";

const nonEmptyString = z.string().min(1);
const optionalNonEmptyString = z.string().min(1).optional();

export const usageSchema = z
  .object({
    unit: z.literal("tool_call"),
    delta: z.number().finite().positive(),
  })
  .strict();

export const meterUploadContextSchema = z
  .object({
    providerId: optionalNonEmptyString,
    customerId: optionalNonEmptyString,
    workspaceId: optionalNonEmptyString,
    seatId: optionalNonEmptyString,
    skillId: optionalNonEmptyString,
    bundleId: optionalNonEmptyString,
    leaseId: optionalNonEmptyString,
    leaseJti: optionalNonEmptyString,
    policyId: optionalNonEmptyString,
  })
  .strict();

export const meterUploadEventSchema = z
  .object({
    prevHash: nonEmptyString,
    seq: z.number().int().nonnegative(),
    at: z.number().int().positive(),
    kind: nonEmptyString,
    hash: optionalNonEmptyString,
    seatId: optionalNonEmptyString,
    tool: optionalNonEmptyString,
    usage: usageSchema.optional(),
    unit: z.literal("tool_call").optional(),
    delta: z.number().finite().positive().optional(),
    providerId: optionalNonEmptyString,
    customerId: optionalNonEmptyString,
    workspaceId: optionalNonEmptyString,
    skillId: optionalNonEmptyString,
    bundleId: optionalNonEmptyString,
    leaseId: optionalNonEmptyString,
    leaseJti: optionalNonEmptyString,
    policyId: optionalNonEmptyString,
    data: z
      .object({
        seatId: optionalNonEmptyString,
        tool: optionalNonEmptyString,
        usageUnit: z.literal("tool_call").optional(),
        usageDelta: z.number().finite().positive().optional(),
        providerId: optionalNonEmptyString,
        customerId: optionalNonEmptyString,
        workspaceId: optionalNonEmptyString,
        skillId: optionalNonEmptyString,
        bundleId: optionalNonEmptyString,
        leaseId: optionalNonEmptyString,
        leaseJti: optionalNonEmptyString,
        policyId: optionalNonEmptyString,
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const meterUploadRequestSchema = z
  .object({
    workspaceId: nonEmptyString,
    context: meterUploadContextSchema.optional(),
    events: z.array(meterUploadEventSchema),
  })
  .strict();

export const acceptedUsageEventSchema = z
  .object({
    eventId: nonEmptyString,
    providerId: nonEmptyString,
    customerId: nonEmptyString,
    workspaceId: nonEmptyString,
    seatId: nonEmptyString,
    skillId: optionalNonEmptyString.nullable(),
    bundleId: optionalNonEmptyString.nullable(),
    leaseId: optionalNonEmptyString.nullable(),
    leaseJti: optionalNonEmptyString.nullable(),
    policyId: optionalNonEmptyString.nullable(),
    tool: nonEmptyString,
    eventKind: nonEmptyString,
    usage: usageSchema,
    eventSeq: z.number().int().nonnegative(),
    eventHash: optionalNonEmptyString.nullable(),
    prevHash: nonEmptyString,
    eventAtSec: z.number().int().positive(),
    rawEvent: z.record(z.any()),
  })
  .strict();

export const providerCreateSchema = z
  .object({
    providerId: nonEmptyString,
    name: optionalNonEmptyString,
  })
  .strict();

export const customerCreateSchema = z
  .object({
    customerId: nonEmptyString,
    name: optionalNonEmptyString,
  })
  .strict();

export const workspaceCreateSchema = z
  .object({
    workspaceId: nonEmptyString,
    providerId: nonEmptyString,
    customerId: nonEmptyString,
    name: optionalNonEmptyString,
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  })
  .strict();

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickNonEmptyString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function normalizeUsage(rawEvent) {
  const usage =
    rawEvent.usage ??
    (rawEvent.unit !== undefined || rawEvent.delta !== undefined
      ? { unit: rawEvent.unit, delta: rawEvent.delta }
      : rawEvent.data?.usageUnit !== undefined || rawEvent.data?.usageDelta !== undefined
        ? {
            unit: rawEvent.data?.usageUnit,
            delta: rawEvent.data?.usageDelta,
          }
        : null);

  if (!usage) throw new Error("meter_event_missing_usage");
  const parsed = usageSchema.safeParse(usage);
  if (!parsed.success) {
    const issuePath = parsed.error.issues[0]?.path?.[0];
    if (issuePath === "unit") throw new Error("meter_event_invalid_usage_unit");
    if (issuePath === "delta") throw new Error("meter_event_invalid_usage_delta");
    throw new Error("meter_event_invalid_usage");
  }
  return parsed.data;
}

function normalizeOptionalId(...candidates) {
  return pickNonEmptyString(...candidates);
}

function normalizeRequiredId({ errorCode, fallback = null }, ...candidates) {
  const value = pickNonEmptyString(...candidates);
  if (value) return value;
  if (fallback !== null) return fallback;
  throw new Error(errorCode);
}

function normalizeContext(upload) {
  const context = upload.context ?? {};
  if (
    context.workspaceId &&
    context.workspaceId !== upload.workspaceId
  ) {
    throw new Error("meter_upload_workspace_context_mismatch");
  }
  return {
    providerId: context.providerId ?? UNKNOWN_PROVIDER_ID,
    customerId: context.customerId ?? UNKNOWN_CUSTOMER_ID,
    workspaceId: upload.workspaceId,
    seatId: context.seatId ?? null,
    skillId: context.skillId ?? null,
    bundleId: context.bundleId ?? null,
    leaseId: context.leaseId ?? null,
    leaseJti: context.leaseJti ?? null,
    policyId: context.policyId ?? null,
  };
}

function isUsageEventCandidate(event) {
  if (event.kind === "tool_call") return true;
  if (event.usage !== undefined) return true;
  if (event.unit !== undefined || event.delta !== undefined) return true;
  if (event.data?.usageUnit !== undefined || event.data?.usageDelta !== undefined) return true;
  return false;
}

function normalizeEvent(uploadContext, event, options = {}) {
  const {
    useAcceptedCommercialContextOnly = false,
    useAcceptedSeatIdOnly = false,
  } = options;
  const workspaceFromEvent = useAcceptedCommercialContextOnly
    ? null
    : pickNonEmptyString(event.workspaceId, event.data?.workspaceId);
  if (workspaceFromEvent && workspaceFromEvent !== uploadContext.workspaceId) {
    throw new Error("meter_event_workspace_mismatch");
  }

  const seatId = useAcceptedSeatIdOnly
    ? normalizeRequiredId(
        { errorCode: "meter_event_invalid_seat_id", fallback: uploadContext.seatId ?? "default" },
        uploadContext.seatId
      )
    : normalizeRequiredId(
        { errorCode: "meter_event_invalid_seat_id", fallback: uploadContext.seatId ?? "default" },
        event.seatId,
        event.data?.seatId
      );
  const tool = normalizeRequiredId(
    { errorCode: "meter_event_invalid_tool" },
    event.tool,
    event.data?.tool
  );
  const usage = normalizeUsage(event);
  const leaseJti = useAcceptedCommercialContextOnly
    ? normalizeOptionalId(uploadContext.leaseJti)
    : normalizeOptionalId(event.leaseJti, event.data?.leaseJti, uploadContext.leaseJti);
  const providerId = useAcceptedCommercialContextOnly
    ? normalizeRequiredId(
        { errorCode: "meter_event_invalid_provider_id" },
        uploadContext.providerId
      )
    : normalizeRequiredId(
        { errorCode: "meter_event_invalid_provider_id", fallback: uploadContext.providerId },
        event.providerId,
        event.data?.providerId
      );
  const customerId = useAcceptedCommercialContextOnly
    ? normalizeRequiredId(
        { errorCode: "meter_event_invalid_customer_id" },
        uploadContext.customerId
      )
    : normalizeRequiredId(
        { errorCode: "meter_event_invalid_customer_id", fallback: uploadContext.customerId },
        event.customerId,
        event.data?.customerId
      );
  const skillId = useAcceptedCommercialContextOnly
    ? normalizeOptionalId(uploadContext.skillId)
    : normalizeOptionalId(event.skillId, event.data?.skillId, uploadContext.skillId);
  const bundleId = useAcceptedCommercialContextOnly
    ? normalizeOptionalId(uploadContext.bundleId)
    : normalizeOptionalId(event.bundleId, event.data?.bundleId, uploadContext.bundleId);
  const leaseId = useAcceptedCommercialContextOnly
    ? normalizeOptionalId(uploadContext.leaseId)
    : normalizeOptionalId(event.leaseId, event.data?.leaseId, uploadContext.leaseId);
  const policyId = useAcceptedCommercialContextOnly
    ? normalizeOptionalId(uploadContext.policyId)
    : normalizeOptionalId(event.policyId, event.data?.policyId, uploadContext.policyId);

  const normalized = {
    eventId: `${encodeURIComponent(uploadContext.workspaceId)}:${encodeURIComponent(seatId)}:${encodeURIComponent(leaseJti ?? "")}:${event.seq}`,
    providerId,
    customerId,
    workspaceId: uploadContext.workspaceId,
    seatId,
    skillId,
    bundleId,
    leaseId,
    leaseJti,
    policyId,
    tool,
    eventKind: event.kind,
    usage,
    eventSeq: event.seq,
    eventHash: event.hash ?? null,
    prevHash: event.prevHash,
    eventAtSec: event.at,
    rawEvent: event,
  };
  const accepted = acceptedUsageEventSchema.safeParse(normalized);
  if (!accepted.success) throw new Error("accepted_usage_event_invalid_contract");
  return accepted.data;
}

export function validateDirectLeaseCommercialContext(payload) {
  for (const key of ["providerId", "workspaceId", "skillId", "bundleId"]) {
    if (typeof payload?.[key] !== "string" || payload[key].length === 0) {
      throw new Error(`lease_payload_missing_${key}`);
    }
  }
  return payload;
}

export function validateDirectMeterUploadContract(payload, acceptedContext) {
  if (!isPlainObject(payload)) {
    throw new Error("meter_upload_invalid_body");
  }
  if (!Array.isArray(payload.events)) {
    throw new Error("meter_upload_missing_events");
  }

  const parsed = z
    .object({
      events: z.array(meterUploadEventSchema),
    })
    .strict()
    .safeParse(payload);
  if (!parsed.success) throw new Error("meter_upload_invalid_contract");

  const events = [];
  for (const event of parsed.data.events) {
    if (!isUsageEventCandidate(event)) continue;
    events.push(
      normalizeEvent(acceptedContext, event, {
        useAcceptedCommercialContextOnly: true,
        useAcceptedSeatIdOnly: true,
      })
    );
  }
  return { workspaceId: acceptedContext.workspaceId, context: acceptedContext, events };
}

export function validateMeterUploadContract(payload) {
  if (!isPlainObject(payload)) {
    throw new Error("meter_upload_invalid_body");
  }
  if (typeof payload.workspaceId !== "string" || payload.workspaceId.length === 0) {
    throw new Error("meter_upload_missing_workspace_id");
  }
  if (!Array.isArray(payload.events)) {
    throw new Error("meter_upload_missing_events");
  }

  const parsed = meterUploadRequestSchema.safeParse(payload);
  if (!parsed.success) throw new Error("meter_upload_invalid_contract");
  const context = normalizeContext(parsed.data);
  const events = [];
  for (const event of parsed.data.events) {
    if (!isUsageEventCandidate(event)) continue;
    events.push(normalizeEvent(context, event));
  }
  return { workspaceId: context.workspaceId, context, events };
}

export function validateAcceptedUsageSummaryRow(row) {
  const schema = z
    .object({
      providerId: nonEmptyString,
      customerId: nonEmptyString,
      workspaceId: nonEmptyString,
      seatId: nonEmptyString,
      skillId: optionalNonEmptyString.nullable(),
      bundleId: optionalNonEmptyString.nullable(),
      leaseJti: optionalNonEmptyString.nullable(),
      tool: nonEmptyString,
      unit: z.literal("tool_call"),
      totalCalls: z.number().finite().nonnegative(),
    })
    .strict();
  const parsed = schema.safeParse(row);
  if (!parsed.success) throw new Error("usage_summary_invalid_row");
  return parsed.data;
}

export function validateProviderCreateContract(payload) {
  const parsed = providerCreateSchema.safeParse(payload);
  if (!parsed.success) throw new Error("provider_invalid_contract");
  return parsed.data;
}

export function validateCustomerCreateContract(payload) {
  const parsed = customerCreateSchema.safeParse(payload);
  if (!parsed.success) throw new Error("customer_invalid_contract");
  return parsed.data;
}

export function validateWorkspaceCreateContract(payload) {
  const parsed = workspaceCreateSchema.safeParse(payload);
  if (!parsed.success) throw new Error("workspace_invalid_contract");
  return {
    ...parsed.data,
    status: parsed.data.status ?? "ACTIVE",
  };
}

export const commercialContractInternals = {
  UNKNOWN_PROVIDER_ID,
  UNKNOWN_CUSTOMER_ID,
};
