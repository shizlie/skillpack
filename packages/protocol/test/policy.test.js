import { expect, test } from "bun:test";

import {
  evaluateEffectiveTimeWindow,
  evaluatePolicyDecision,
  evaluateTimeState,
  evaluateUsageState,
  validatePolicySnapshot,
} from "../src/index.js";

test("validatePolicySnapshot accepts valid workspace + seat policy", () => {
  expect(() =>
    validatePolicySnapshot({
      policyVersion: 1,
      policyId: "pol_1",
      workspaceId: "ws_1",
      workspacePolicy: { mode: "ENABLED" },
      seatPolicy: {
        defaultMode: "ENABLED",
        seats: { seatA: { mode: "ENABLED" } },
      },
      usagePolicy: {
        unit: "tool_call",
        thresholds: { warningPct: 100, hardStopPct: 120 },
        toolBudgets: { wiki_search: 100 },
      },
      timePolicy: {
        workspace: { startsAtSec: 100, expiresAtSec: 200, graceUntilSec: 260 },
        seatOverrides: {
          seatA: { startsAtSec: 120, expiresAtSec: 180, graceUntilSec: 240 },
        },
      },
    })
  ).not.toThrow();
});

test("evaluateEffectiveTimeWindow uses stricter workspace-seat intersection", () => {
  const out = evaluateEffectiveTimeWindow(
    { startsAtSec: 100, expiresAtSec: 200, graceUntilSec: 260 },
    { startsAtSec: 120, expiresAtSec: 180, graceUntilSec: 240 }
  );

  expect(out).toEqual({
    startsAtSec: 120,
    expiresAtSec: 180,
    graceUntilSec: 240,
  });
});

test("evaluateUsageState applies threshold boundaries", () => {
  expect(evaluateUsageState({ actual: 99, budget: 100 })).toBe("NORMAL");
  expect(evaluateUsageState({ actual: 100, budget: 100 })).toBe("WARNING");
  expect(evaluateUsageState({ actual: 120, budget: 100 })).toBe("WARNING");
  expect(evaluateUsageState({ actual: 121, budget: 100 })).toBe("HARD_STOP");
});

test("evaluatePolicyDecision applies deny precedence and warning outcome", () => {
  expect(
    evaluatePolicyDecision({
      workspaceMode: "DISABLED",
      seatMode: "ENABLED",
      timeState: "ACTIVE",
      usageState: "NORMAL",
    })
  ).toEqual({ decision: "DENY", reasonCodes: ["workspace_disabled"] });

  expect(
    evaluatePolicyDecision({
      workspaceMode: "ENABLED",
      seatMode: "DISABLED",
      timeState: "GRACE",
      usageState: "WARNING",
    })
  ).toEqual({ decision: "DENY", reasonCodes: ["seat_disabled"] });

  expect(
    evaluatePolicyDecision({
      workspaceMode: "ENABLED",
      seatMode: "ENABLED",
      timeState: "NOT_STARTED",
      usageState: "NORMAL",
    })
  ).toEqual({ decision: "DENY", reasonCodes: ["time_not_started"] });

  expect(
    evaluatePolicyDecision({
      workspaceMode: "ENABLED",
      seatMode: "ENABLED",
      timeState: "EXPIRED",
      usageState: "WARNING",
    })
  ).toEqual({ decision: "DENY", reasonCodes: ["time_expired"] });

  expect(
    evaluatePolicyDecision({
      workspaceMode: "ENABLED",
      seatMode: "ENABLED",
      timeState: "ACTIVE",
      usageState: "HARD_STOP",
    })
  ).toEqual({ decision: "DENY", reasonCodes: ["usage_hard_stop"] });

  expect(
    evaluatePolicyDecision({
      workspaceMode: "ENABLED",
      seatMode: "ENABLED",
      timeState: "GRACE",
      usageState: "WARNING",
    })
  ).toEqual({
    decision: "ALLOW_WITH_WARNING",
    reasonCodes: ["time_grace", "usage_warning"],
  });

  expect(
    evaluatePolicyDecision({
      workspaceMode: "ENABLED",
      seatMode: "ENABLED",
      timeState: "ACTIVE",
      usageState: "NORMAL",
    })
  ).toEqual({ decision: "ALLOW", reasonCodes: [] });
});

test("evaluateTimeState returns active, grace, expired and not_started", () => {
  expect(
    evaluateTimeState({
      nowSec: 99,
      startsAtSec: 100,
      expiresAtSec: 200,
      graceUntilSec: 260,
    })
  ).toBe("NOT_STARTED");

  expect(
    evaluateTimeState({
      nowSec: 200,
      startsAtSec: 100,
      expiresAtSec: 200,
      graceUntilSec: 260,
    })
  ).toBe("ACTIVE");

  expect(
    evaluateTimeState({
      nowSec: 240,
      startsAtSec: 100,
      expiresAtSec: 200,
      graceUntilSec: 260,
    })
  ).toBe("GRACE");

  expect(
    evaluateTimeState({
      nowSec: 261,
      startsAtSec: 100,
      expiresAtSec: 200,
      graceUntilSec: 260,
    })
  ).toBe("EXPIRED");
});

test("evaluateUsageState: threshold boundaries (100% = WARNING, exactly 120% = WARNING, 121% = HARD_STOP)", () => {
  // At 100% (= warningPct): WARNING
  expect(evaluateUsageState({ actual: 10, budget: 10, warningPct: 100, hardStopPct: 120 })).toBe("WARNING");
  // At exactly 120% (= hardStopPct): still WARNING — HARD_STOP requires strictly > hardStopPct
  expect(evaluateUsageState({ actual: 12, budget: 10, warningPct: 100, hardStopPct: 120 })).toBe("WARNING");
  // Above 120%: HARD_STOP
  expect(evaluateUsageState({ actual: 13, budget: 10, warningPct: 100, hardStopPct: 120 })).toBe("HARD_STOP");
  // Below 100%: NORMAL
  expect(evaluateUsageState({ actual: 9, budget: 10, warningPct: 100, hardStopPct: 120 })).toBe("NORMAL");
});
