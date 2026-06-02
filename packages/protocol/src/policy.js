function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateMode(mode, errorCode) {
  if (mode !== "ENABLED" && mode !== "DISABLED") {
    throw new Error(errorCode);
  }
}

function validateTimeWindow(window, prefix) {
  if (!isPlainObject(window)) {
    throw new Error(`${prefix}_invalid_object`);
  }

  const required = ["startsAtSec", "expiresAtSec", "graceUntilSec"];
  for (const key of required) {
    if (!Number.isInteger(window[key]) || window[key] <= 0) {
      throw new Error(`${prefix}_invalid_${key}`);
    }
  }

  if (window.expiresAtSec < window.startsAtSec) {
    throw new Error(`${prefix}_expires_before_start`);
  }
  if (window.graceUntilSec < window.expiresAtSec) {
    throw new Error(`${prefix}_grace_before_expiry`);
  }

  return window;
}

export function validatePolicySnapshot(policy) {
  if (!isPlainObject(policy)) {
    throw new Error("policy_snapshot_invalid_object");
  }

  const required = [
    "policyVersion",
    "policyId",
    "workspaceId",
    "workspacePolicy",
    "seatPolicy",
    "usagePolicy",
    "timePolicy",
  ];

  for (const key of required) {
    if (policy[key] === undefined || policy[key] === null) {
      throw new Error(`policy_snapshot_missing_${key}`);
    }
  }

  if (!Number.isInteger(policy.policyVersion) || policy.policyVersion <= 0) {
    throw new Error("policy_snapshot_invalid_version");
  }
  if (typeof policy.policyId !== "string" || policy.policyId.length === 0) {
    throw new Error("policy_snapshot_invalid_policy_id");
  }
  if (typeof policy.workspaceId !== "string" || policy.workspaceId.length === 0) {
    throw new Error("policy_snapshot_invalid_workspace_id");
  }

  if (!isPlainObject(policy.workspacePolicy)) {
    throw new Error("policy_snapshot_invalid_workspace_policy");
  }
  validateMode(
    policy.workspacePolicy.mode,
    "policy_snapshot_invalid_workspace_mode"
  );

  if (!isPlainObject(policy.seatPolicy)) {
    throw new Error("policy_snapshot_invalid_seat_policy");
  }
  validateMode(
    policy.seatPolicy.defaultMode,
    "policy_snapshot_invalid_seat_default_mode"
  );
  if (
    policy.seatPolicy.seats !== undefined &&
    !isPlainObject(policy.seatPolicy.seats)
  ) {
    throw new Error("policy_snapshot_invalid_seat_overrides");
  }
  if (isPlainObject(policy.seatPolicy.seats)) {
    for (const seat of Object.values(policy.seatPolicy.seats)) {
      if (!isPlainObject(seat)) {
        throw new Error("policy_snapshot_invalid_seat_override");
      }
      validateMode(seat.mode, "policy_snapshot_invalid_seat_mode");
    }
  }

  if (!isPlainObject(policy.usagePolicy)) {
    throw new Error("policy_snapshot_invalid_usage_policy");
  }
  if (policy.usagePolicy.unit !== "tool_call") {
    throw new Error("policy_snapshot_invalid_usage_unit");
  }
  if (!isPlainObject(policy.usagePolicy.thresholds)) {
    throw new Error("policy_snapshot_invalid_usage_thresholds");
  }
  const warningPct = policy.usagePolicy.thresholds.warningPct;
  const hardStopPct = policy.usagePolicy.thresholds.hardStopPct;
  if (!Number.isFinite(warningPct) || warningPct < 0) {
    throw new Error("policy_snapshot_invalid_warning_pct");
  }
  if (!Number.isFinite(hardStopPct) || hardStopPct < 0) {
    throw new Error("policy_snapshot_invalid_hard_stop_pct");
  }
  if (hardStopPct < warningPct) {
    throw new Error("policy_snapshot_invalid_threshold_order");
  }
  if (!isPlainObject(policy.usagePolicy.toolBudgets)) {
    throw new Error("policy_snapshot_invalid_tool_budgets");
  }
  for (const budget of Object.values(policy.usagePolicy.toolBudgets)) {
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error("policy_snapshot_invalid_tool_budget");
    }
  }

  if (!isPlainObject(policy.timePolicy)) {
    throw new Error("policy_snapshot_invalid_time_policy");
  }
  validateTimeWindow(policy.timePolicy.workspace, "policy_snapshot_workspace");

  if (
    policy.timePolicy.seatOverrides !== undefined &&
    !isPlainObject(policy.timePolicy.seatOverrides)
  ) {
    throw new Error("policy_snapshot_invalid_time_seat_overrides");
  }
  if (isPlainObject(policy.timePolicy.seatOverrides)) {
    for (const override of Object.values(policy.timePolicy.seatOverrides)) {
      validateTimeWindow(override, "policy_snapshot_seat_window");
    }
  }

  return policy;
}

export function evaluateEffectiveTimeWindow(workspaceWindow, seatWindow) {
  validateTimeWindow(workspaceWindow, "policy_time_workspace");
  if (seatWindow === undefined || seatWindow === null) {
    return {
      startsAtSec: workspaceWindow.startsAtSec,
      expiresAtSec: workspaceWindow.expiresAtSec,
      graceUntilSec: workspaceWindow.graceUntilSec,
    };
  }

  validateTimeWindow(seatWindow, "policy_time_seat");

  return {
    startsAtSec: Math.max(workspaceWindow.startsAtSec, seatWindow.startsAtSec),
    expiresAtSec: Math.min(
      workspaceWindow.expiresAtSec,
      seatWindow.expiresAtSec
    ),
    graceUntilSec: Math.min(
      workspaceWindow.graceUntilSec,
      seatWindow.graceUntilSec
    ),
  };
}

export function evaluateUsageState({
  actual,
  budget,
  warningPct = 100,
  hardStopPct = 120,
}) {
  if (!Number.isFinite(actual) || actual < 0) {
    throw new Error("policy_usage_invalid_actual");
  }
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error("policy_usage_invalid_budget");
  }
  if (!Number.isFinite(warningPct) || warningPct < 0) {
    throw new Error("policy_usage_invalid_warning_pct");
  }
  if (!Number.isFinite(hardStopPct) || hardStopPct < warningPct) {
    throw new Error("policy_usage_invalid_hard_stop_pct");
  }

  const pct = (actual / budget) * 100;

  if (pct > hardStopPct) return "HARD_STOP";
  if (pct >= warningPct) return "WARNING";
  return "NORMAL";
}

export function evaluateTimeState({
  nowSec,
  startsAtSec,
  expiresAtSec,
  graceUntilSec,
}) {
  if (!Number.isInteger(nowSec) || nowSec <= 0) {
    throw new Error("policy_time_invalid_now");
  }

  validateTimeWindow(
    { startsAtSec, expiresAtSec, graceUntilSec },
    "policy_time_window"
  );

  if (nowSec < startsAtSec) return "NOT_STARTED";
  if (nowSec <= expiresAtSec) return "ACTIVE";
  if (nowSec <= graceUntilSec) return "GRACE";
  return "EXPIRED";
}

export function evaluatePolicyDecision({
  workspaceMode,
  seatMode,
  timeState,
  usageState,
}) {
  const reasonCodes = [];

  if (workspaceMode === "DISABLED") {
    return { decision: "DENY", reasonCodes: ["workspace_disabled"] };
  }

  if (seatMode === "DISABLED") {
    return { decision: "DENY", reasonCodes: ["seat_disabled"] };
  }

  if (timeState === "NOT_STARTED") {
    return { decision: "DENY", reasonCodes: ["time_not_started"] };
  }

  if (timeState === "EXPIRED") {
    return { decision: "DENY", reasonCodes: ["time_expired"] };
  }

  if (usageState === "HARD_STOP") {
    return { decision: "DENY", reasonCodes: ["usage_hard_stop"] };
  }

  if (timeState === "GRACE") {
    reasonCodes.push("time_grace");
  }

  if (usageState === "WARNING") {
    reasonCodes.push("usage_warning");
  }

  if (reasonCodes.length > 0) {
    return { decision: "ALLOW_WITH_WARNING", reasonCodes };
  }

  return { decision: "ALLOW", reasonCodes: [] };
}

/**
 * Composite policy decision for a single tool call.
 * Aggregates the per-dimension policy decisions (workspace mode, seat mode,
 * effective time window, usage budget) into a single allow/warn/deny result.
 *
 * @param {object} opts
 * @param {object} opts.policy — validated policy snapshot (or null/undefined for no-policy mode)
 * @param {string} [opts.seatId="default"]
 * @param {string} opts.toolName
 * @param {number} [opts.currentCount=0] — caller's current accumulated usage for this tool
 * @param {number} [opts.nowSec] — caller's "now" in epoch seconds; defaults to Date.now()/1000
 * @returns {{ decision: "ALLOW"|"ALLOW_WITH_WARNING"|"DENY", reasonCodes: string[], usageState: string, nextCount: number, budget: number|undefined }}
 */
export function evaluatePolicyToolCallDecision({
  policy,
  seatId = "default",
  toolName,
  currentCount = 0,
  nowSec = Math.floor(Date.now() / 1000),
}) {
  if (!policy) {
    return {
      decision: "ALLOW",
      reasonCodes: [],
      usageState: "NORMAL",
      nextCount: currentCount + 1,
      budget: undefined,
    };
  }
  if (typeof toolName !== "string" || toolName.length === 0) {
    throw new Error("policy_tool_invalid_name");
  }
  if (!Number.isInteger(currentCount) || currentCount < 0) {
    throw new Error("policy_usage_invalid_actual");
  }
  const seatMode = policy.seatPolicy.seats?.[seatId]?.mode ?? policy.seatPolicy.defaultMode;
  const effectiveWindow = evaluateEffectiveTimeWindow(
    policy.timePolicy.workspace,
    policy.timePolicy.seatOverrides?.[seatId]
  );
  const timeState = evaluateTimeState({
    nowSec,
    startsAtSec: effectiveWindow.startsAtSec,
    expiresAtSec: effectiveWindow.expiresAtSec,
    graceUntilSec: effectiveWindow.graceUntilSec,
  });
  const nextCount = currentCount + 1;
  const budget = policy.usagePolicy.toolBudgets[toolName];
  let usageState = "NORMAL";
  if (Number.isFinite(budget) && budget > 0) {
    usageState = evaluateUsageState({
      actual: nextCount,
      budget,
      warningPct: policy.usagePolicy.thresholds.warningPct,
      hardStopPct: policy.usagePolicy.thresholds.hardStopPct,
    });
  }
  return {
    ...evaluatePolicyDecision({
      workspaceMode: policy.workspacePolicy.mode,
      seatMode,
      timeState,
      usageState,
    }),
    usageState,
    nextCount,
    budget,
  };
}
