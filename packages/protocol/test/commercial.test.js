import { expect, test } from "bun:test";

import {
  validateCustomerCreateContract,
  validateAcceptedUsageSummaryRow,
  validateDirectLeaseCommercialContext,
  validateDirectMeterUploadContract,
  validateMeterUploadContract,
  validateProviderCreateContract,
  validateWorkspaceCreateContract,
} from "../src/index.js";

test("validateMeterUploadContract normalizes legacy meter events", () => {
  const out = validateMeterUploadContract({
    workspaceId: "ws-1",
    context: {
      providerId: "prov-1",
      customerId: "cust-1",
      skillId: "skill-1",
      bundleId: "bundle-1",
    },
    events: [
      {
        prevHash: "h0",
        seq: 1,
        at: 1_800_000_000,
        kind: "tool_call",
        seatId: "seat-1",
        tool: "wiki_search",
        usage: { unit: "tool_call", delta: 2 },
      },
    ],
  });

  expect(out.workspaceId).toBe("ws-1");
  expect(out.events).toHaveLength(1);
  expect(out.events[0]).toMatchObject({
    providerId: "prov-1",
    customerId: "cust-1",
    workspaceId: "ws-1",
    seatId: "seat-1",
    skillId: "skill-1",
    bundleId: "bundle-1",
    tool: "wiki_search",
    usage: { unit: "tool_call", delta: 2 },
    eventSeq: 1,
  });
});

test("validateMeterUploadContract normalizes runtime data payload shape", () => {
  const out = validateMeterUploadContract({
    workspaceId: "ws-1",
    context: {
      providerId: "prov-1",
      customerId: "cust-1",
      leaseJti: "lease-jti-1",
    },
    events: [
      {
        prevHash: "h0",
        seq: 7,
        at: 1_800_000_700,
        kind: "tool_call",
        data: {
          seatId: "seat-7",
          tool: "wiki_read_page",
          usageUnit: "tool_call",
          usageDelta: 1,
          policyId: "pol-7",
        },
      },
    ],
  });

  expect(out.events[0]).toMatchObject({
    seatId: "seat-7",
    tool: "wiki_read_page",
    leaseJti: "lease-jti-1",
    policyId: "pol-7",
    usage: { unit: "tool_call", delta: 1 },
  });
});

test("validateMeterUploadContract rejects workspace mismatch", () => {
  expect(() =>
    validateMeterUploadContract({
      workspaceId: "ws-1",
      events: [
        {
          prevHash: "h0",
          seq: 1,
          at: 1_800_000_001,
          kind: "tool_call",
          seatId: "seat-1",
          tool: "wiki_search",
          usage: { unit: "tool_call", delta: 1 },
          workspaceId: "ws-other",
        },
      ],
    })
  ).toThrow(/meter_event_workspace_mismatch/);
});

test("validateMeterUploadContract accepts empty events array", () => {
  const out = validateMeterUploadContract({ workspaceId: "ws-1", events: [] });
  expect(out.workspaceId).toBe("ws-1");
  expect(out.events).toHaveLength(0);
});

test("validateMeterUploadContract ignores non-billable runtime lifecycle events", () => {
  const out = validateMeterUploadContract({
    workspaceId: "ws-1",
    events: [
      { prevHash: "h0", seq: 0, at: 1_800_000_000, kind: "session_start", data: { mode: "active" } },
      { prevHash: "h1", seq: 1, at: 1_800_000_001, kind: "tool_call", data: { seatId: "s1", tool: "wiki_search", usageUnit: "tool_call", usageDelta: 1 } },
      { prevHash: "h2", seq: 2, at: 1_800_000_002, kind: "session_end", data: { reason: "stdin_closed" } },
    ],
  });
  expect(out.events).toHaveLength(1);
  expect(out.events[0].eventKind).toBe("tool_call");
  expect(out.events[0].tool).toBe("wiki_search");
});

test("validateMeterUploadContract rejects context workspaceId mismatch", () => {
  expect(() =>
    validateMeterUploadContract({
      workspaceId: "ws-1",
      context: { workspaceId: "ws-other" },
      events: [],
    })
  ).toThrow(/meter_upload_workspace_context_mismatch/);
});

test("validateMeterUploadContract rejects missing usage", () => {
  expect(() =>
    validateMeterUploadContract({
      workspaceId: "ws-1",
      events: [{ prevHash: "h0", seq: 1, at: 1_800_000_000, kind: "tool_call", seatId: "s", tool: "t" }],
    })
  ).toThrow(/meter_event_missing_usage/);
});

test("validateMeterUploadContract rejects malformed usage object (bad unit or delta)", () => {
  // Zod validates usage inline — malformed usage throws meter_event_invalid_contract
  expect(() =>
    validateMeterUploadContract({
      workspaceId: "ws-1",
      events: [{ prevHash: "h0", seq: 1, at: 1_800_000_000, kind: "tool_call", seatId: "s", tool: "t", usage: { unit: "bad", delta: 1 } }],
    })
  ).toThrow(/meter_upload_invalid_contract/);

  expect(() =>
    validateMeterUploadContract({
      workspaceId: "ws-1",
      events: [{ prevHash: "h0", seq: 1, at: 1_800_000_000, kind: "tool_call", seatId: "s", tool: "t", usage: { unit: "tool_call", delta: 0 } }],
    })
  ).toThrow(/meter_upload_invalid_contract/);
});

test("validateMeterUploadContract rejects missing tool", () => {
  expect(() =>
    validateMeterUploadContract({
      workspaceId: "ws-1",
      events: [{ prevHash: "h0", seq: 1, at: 1_800_000_000, kind: "tool_call", usage: { unit: "tool_call", delta: 1 } }],
    })
  ).toThrow(/meter_event_invalid_tool/);
});

test("validateMeterUploadContract rejects non-object payload", () => {
  expect(() => validateMeterUploadContract(null)).toThrow(/meter_upload_invalid_body/);
  expect(() => validateMeterUploadContract([])).toThrow(/meter_upload_invalid_body/);
});

test("eventId includes leaseJti to prevent PK collision across lease renewals", () => {
  const base = {
    workspaceId: "ws-1",
    events: [{ prevHash: "h0", seq: 0, at: 1_800_000_000, kind: "tool_call", seatId: "seat-1", tool: "t", usage: { unit: "tool_call", delta: 1 } }],
  };
  const leaseA = validateMeterUploadContract({ ...base, context: { leaseJti: "jti-a" } });
  const leaseB = validateMeterUploadContract({ ...base, context: { leaseJti: "jti-b" } });
  expect(leaseA.events[0].eventId).not.toBe(leaseB.events[0].eventId);
});

test("validateDirectLeaseCommercialContext requires lease-bound commercial ids", () => {
  expect(() =>
    validateDirectLeaseCommercialContext({
      iss: "skillpack-vendor",
      sub: "cust-1",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
      jti: "lease-jti-1",
      leaseCounter: 0,
      providerId: "prov-1",
      workspaceId: "ws-1",
      skillId: "laws-consultant",
      bundleId: "laws-consultant-1.0.0",
    })
  ).not.toThrow();

  expect(() =>
    validateDirectLeaseCommercialContext({
      providerId: "prov-1",
      workspaceId: "ws-1",
      skillId: "laws-consultant",
    })
  ).toThrow(/lease_payload_missing_bundleId/);
});

test("direct meter upload uses accepted lease context instead of client-supplied commercial ids", () => {
  const accepted = validateDirectMeterUploadContract(
    {
      events: [
        {
          prevHash: "GENESIS",
          seq: 0,
          at: 1_800_000_100,
          kind: "tool_call",
          seatId: "seat-1",
          tool: "wiki_search",
          usage: { unit: "tool_call", delta: 1 },
          providerId: "client-prov",
          customerId: "client-cust",
          workspaceId: "client-forged-ws",
          skillId: "client-skill",
          bundleId: "client-bundle",
          leaseJti: "client-jti",
        },
      ],
    },
    {
      providerId: "prov-1",
      customerId: "cust-1",
      workspaceId: "ws-1",
      skillId: "laws-consultant",
      bundleId: "laws-consultant-1.0.0",
      leaseJti: "lease-jti-1",
      seatId: "seat-1",
    }
  );

  expect(accepted.workspaceId).toBe("ws-1");
  expect(accepted.events[0]).toMatchObject({
    providerId: "prov-1",
    customerId: "cust-1",
    workspaceId: "ws-1",
    skillId: "laws-consultant",
    bundleId: "laws-consultant-1.0.0",
    leaseJti: "lease-jti-1",
  });
});

test("validateAcceptedUsageSummaryRow validates commercial dimensions", () => {
  expect(() =>
    validateAcceptedUsageSummaryRow({
      providerId: "prov-1",
      customerId: "cust-1",
      workspaceId: "ws-1",
      seatId: "seat-1",
      skillId: "skill-1",
      bundleId: "bundle-1",
      leaseJti: "lease-jti-1",
      tool: "wiki_search",
      unit: "tool_call",
      totalCalls: 12,
    })
  ).not.toThrow();
});

test("provider/customer/workspace contracts validate expected shapes", () => {
  expect(() =>
    validateProviderCreateContract({
      providerId: "prov-1",
      name: "Provider One",
    })
  ).not.toThrow();

  expect(() =>
    validateCustomerCreateContract({
      customerId: "cust-1",
      name: "Customer One",
    })
  ).not.toThrow();

  const workspace = validateWorkspaceCreateContract({
    workspaceId: "ws-1",
    providerId: "prov-1",
    customerId: "cust-1",
  });
  expect(workspace.status).toBe("ACTIVE");
});
