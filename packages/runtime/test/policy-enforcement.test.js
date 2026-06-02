import { expect, test } from "bun:test";
import { validatePolicySnapshot, evaluatePolicyToolCallDecision } from "@skillpack/protocol";

function makeBasePolicy(nowSec, overrides = {}) {
  const base = {
    policyVersion: 1,
    policyId: "pol_1",
    workspaceId: "ws_1",
    workspacePolicy: { mode: "ENABLED" },
    seatPolicy: { defaultMode: "ENABLED", seats: {} },
    usagePolicy: {
      unit: "tool_call",
      thresholds: { warningPct: 100, hardStopPct: 120 },
      toolBudgets: { wiki_search: 100, wiki_read_page: 100 },
    },
    timePolicy: {
      workspace: {
        startsAtSec: nowSec - 600,
        expiresAtSec: nowSec + 3600,
        graceUntilSec: nowSec + 7200,
      },
      seatOverrides: {},
    },
  };

  return validatePolicySnapshot({
    ...base,
    ...overrides,
    workspacePolicy: { ...base.workspacePolicy, ...(overrides.workspacePolicy ?? {}) },
    seatPolicy: {
      ...base.seatPolicy,
      ...(overrides.seatPolicy ?? {}),
      seats: {
        ...base.seatPolicy.seats,
        ...(overrides.seatPolicy?.seats ?? {}),
      },
    },
    usagePolicy: {
      ...base.usagePolicy,
      ...(overrides.usagePolicy ?? {}),
      thresholds: {
        ...base.usagePolicy.thresholds,
        ...(overrides.usagePolicy?.thresholds ?? {}),
      },
      toolBudgets: {
        ...base.usagePolicy.toolBudgets,
        ...(overrides.usagePolicy?.toolBudgets ?? {}),
      },
    },
    timePolicy: {
      ...base.timePolicy,
      ...(overrides.timePolicy ?? {}),
      workspace: {
        ...base.timePolicy.workspace,
        ...(overrides.timePolicy?.workspace ?? {}),
      },
      seatOverrides: {
        ...base.timePolicy.seatOverrides,
        ...(overrides.timePolicy?.seatOverrides ?? {}),
      },
    },
  });
}

test("policy enforcement: workspace disabled denies", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec, {
    workspacePolicy: { mode: "DISABLED" },
  });

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "default",
    toolName: "wiki_search",
    currentCount: 0,
    nowSec,
  });

  expect(out.decision).toBe("DENY");
  expect(out.reasonCodes).toEqual(["workspace_disabled"]);
});

test("policy enforcement: warning window allows with warning", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec, {
    usagePolicy: { toolBudgets: { wiki_search: 1, wiki_read_page: 1 } },
  });

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "default",
    toolName: "wiki_search",
    currentCount: 0,
    nowSec,
  });

  expect(out.decision).toBe("ALLOW_WITH_WARNING");
  expect(out.reasonCodes).toContain("usage_warning");
});

test("policy enforcement: usage >120 denies", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec, {
    usagePolicy: { toolBudgets: { wiki_search: 1, wiki_read_page: 1 } },
  });

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "default",
    toolName: "wiki_search",
    currentCount: 1,
    nowSec,
  });

  expect(out.decision).toBe("DENY");
  expect(out.reasonCodes).toEqual(["usage_hard_stop"]);
});

test("policy enforcement: stricter seat time window is honored", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec, {
    seatPolicy: {
      seats: {
        "seat-1": { mode: "ENABLED" },
      },
    },
    timePolicy: {
      seatOverrides: {
        "seat-1": {
          startsAtSec: nowSec - 600,
          expiresAtSec: nowSec - 60,
          graceUntilSec: nowSec - 10,
        },
      },
    },
  });

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "seat-1",
    toolName: "wiki_search",
    currentCount: 0,
    nowSec,
  });

  expect(out.decision).toBe("DENY");
  expect(out.reasonCodes).toEqual(["time_expired"]);
});

test("policy enforcement: seatPolicy.defaultMode DISABLED blocks unknown seatId", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec, {
    seatPolicy: { defaultMode: "DISABLED", seats: {} },
  });

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "unknown-seat",
    toolName: "wiki_search",
    currentCount: 0,
    nowSec,
  });

  expect(out.decision).toBe("DENY");
  expect(out.reasonCodes).toEqual(["seat_disabled"]);
});

test("policy enforcement: explicit seat override DISABLED blocks known seatId", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec, {
    seatPolicy: {
      defaultMode: "ENABLED",
      seats: {
        "seat-1": { mode: "DISABLED" },
      },
    },
  });

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "seat-1",
    toolName: "wiki_search",
    currentCount: 0,
    nowSec,
  });

  expect(out.decision).toBe("DENY");
  expect(out.reasonCodes).toEqual(["seat_disabled"]);
});

test("policy enforcement: workspace time NOT_STARTED denies", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec, {
    timePolicy: {
      workspace: {
        startsAtSec: nowSec + 60,
        expiresAtSec: nowSec + 3600,
        graceUntilSec: nowSec + 7200,
      },
    },
  });

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "default",
    toolName: "wiki_search",
    currentCount: 0,
    nowSec,
  });

  expect(out.decision).toBe("DENY");
  expect(out.reasonCodes).toEqual(["time_not_started"]);
});

test("policy enforcement: GRACE + NORMAL usage allows with time warning", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec, {
    usagePolicy: {
      toolBudgets: { wiki_search: 100, wiki_read_page: 100 },
    },
    timePolicy: {
      workspace: {
        startsAtSec: nowSec - 7200,
        expiresAtSec: nowSec - 60,
        graceUntilSec: nowSec + 600,
      },
    },
  });

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "default",
    toolName: "wiki_search",
    currentCount: 0,
    nowSec,
  });

  expect(out.decision).toBe("ALLOW_WITH_WARNING");
  expect(out.reasonCodes).toEqual(["time_grace"]);
});

test("policy enforcement: GRACE + usage warning returns both reason codes", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec, {
    usagePolicy: {
      toolBudgets: { wiki_search: 1, wiki_read_page: 1 },
    },
    timePolicy: {
      workspace: {
        startsAtSec: nowSec - 7200,
        expiresAtSec: nowSec - 60,
        graceUntilSec: nowSec + 600,
      },
    },
  });

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "default",
    toolName: "wiki_search",
    currentCount: 0,
    nowSec,
  });

  expect(out.decision).toBe("ALLOW_WITH_WARNING");
  expect(out.reasonCodes).toEqual(["time_grace", "usage_warning"]);
});

test("policy enforcement: exactly at hard-stop threshold is still warning", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec, {
    usagePolicy: {
      thresholds: { warningPct: 100, hardStopPct: 120 },
      toolBudgets: { wiki_search: 10, wiki_read_page: 10 },
    },
  });

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "default",
    toolName: "wiki_search",
    currentCount: 11, // nextCount = 12 => exactly 120% of budget(10)
    nowSec,
  });

  expect(out.decision).toBe("ALLOW_WITH_WARNING");
  expect(out.reasonCodes).toEqual(["usage_warning"]);
});

test("policy enforcement: tool not in toolBudgets is uncapped (no usage enforcement)", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const policy = makeBasePolicy(nowSec);

  const out = evaluatePolicyToolCallDecision({
    policy,
    seatId: "default",
    toolName: "unregistered_tool",
    currentCount: 9999,
    nowSec,
  });

  expect(out.decision).toBe("ALLOW");
  expect(out.budget).toBeUndefined();
  expect(out.usageState).toBe("NORMAL");
});
