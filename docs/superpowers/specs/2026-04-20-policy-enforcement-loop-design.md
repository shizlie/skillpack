# Policy Enforcement Loop Design (Workspace + Seat + Usage + Time)

## Goal

Define a v1 policy and enforcement model that proves commercial value end-to-end between platform and receiver: issue access, meter usage, warn at thresholds, and stop when limits are exceeded.

## Decisions (Locked)

- Usage meter unit: `tool_call`
- Time policy precedence: stricter wins (workspace + seat intersection)
- Offline behavior: hybrid (fail-open during signed policy grace window, then fail-closed)
- Degraded mode behavior: warning-only (no throttling, no result clipping)

## Non-Goals (v1)

- Weighted credit systems
- Token-based billing
- Real-time push revocation in fully air-gapped environments
- UI dashboard implementation

## Architecture Overview

Two-plane architecture:

1. Platform (control plane)
- Issues signed lease + signed policy snapshot
- Accepts meter batches
- Computes usage summaries
- Controls workspace/seat state and renewal/revocation semantics

2. Receiver (data plane)
- Verifies signed lease and signed policy snapshot
- Enforces policy locally per tool call
- Emits tamper-evident meter events
- Syncs meter and policy when connected

## Policy Contract (v1)

```json
{
  "policyVersion": 1,
  "policyId": "pol_2026_04_20_001",
  "workspaceId": "ws_abc",
  "issuedAtSec": 1760937600,
  "expiresAtSec": 1761110400,
  "workspacePolicy": {
    "mode": "ENABLED"
  },
  "seatPolicy": {
    "defaultMode": "ENABLED",
    "seats": {
      "seat_1": { "mode": "ENABLED" },
      "seat_2": { "mode": "DISABLED" }
    }
  },
  "usagePolicy": {
    "unit": "tool_call",
    "window": "MONTHLY",
    "thresholds": {
      "warningPct": 100,
      "hardStopPct": 120
    },
    "toolBudgets": {
      "wiki_search": 10000,
      "wiki_read_page": 30000
    }
  },
  "timePolicy": {
    "workspace": {
      "startsAtSec": 1760937600,
      "expiresAtSec": 1761024000,
      "graceUntilSec": 1761110400
    },
    "seatOverrides": {
      "seat_1": {
        "startsAtSec": 1760937600,
        "expiresAtSec": 1761000000,
        "graceUntilSec": 1761086400
      }
    }
  }
}
```

## Lease Contract (v1)

Keep lease as identity + monotonic counter primitive. Policy contract above is signed separately and evaluated with lease context.

Required fields:

- `sub` (workspace/customer identity)
- `seatId`
- `iat`, `exp`, `jti`
- `leaseCounter`

## Effective Time Evaluation

Inputs:

- Workspace time window (required)
- Optional seat override window

Rule:

- If seat window exists, effective window = strict intersection:
  - `effectiveStart = max(workspace.start, seat.start)`
  - `effectiveExpire = min(workspace.expire, seat.expire)`
  - `effectiveGrace = min(workspace.graceUntil, seat.graceUntil)`
- If no seat override, use workspace window

States:

- `ACTIVE` when `now <= effectiveExpire`
- `GRACE` when `effectiveExpire < now <= effectiveGrace`
- `EXPIRED` when `now > effectiveGrace`

## Usage Evaluation

Counters are tracked by:

- `workspaceId + seatId + toolName + billingWindow`

Budget basis:

- `budget = usagePolicy.toolBudgets[toolName]`
- `pct = (actual / budget) * 100`

States:

- `NORMAL` when `pct < 100`
- `WARNING` when `100 <= pct <= 120`
- `HARD_STOP` when `pct > 120`

## Enforcement Decision Engine (Receiver)

Per tool call, evaluate in this order:

1. Workspace mode
- If `DISABLED` => `DENY (workspace_disabled)`

2. Seat mode
- If seat disabled => `DENY (seat_disabled)`

3. Time state
- If `EXPIRED` => `DENY (time_expired)`
- If `GRACE` => continue with warning context

4. Usage state
- If `HARD_STOP` => `DENY (usage_hard_stop)`
- If `WARNING` => continue with warning context

5. Final decision
- `ALLOW`
- `ALLOW_WITH_WARNING`
- `DENY`

Warning-only degraded mode:

- No functional degradation
- Include machine-readable warnings in tool response metadata
- Append warnings to meter event data

## Offline/Sync Behavior

Receiver stores:

- last valid signed policy snapshot
- `policyFetchedAtSec`
- `policyOfflineGraceUntilSec`

Offline rule:

- If disconnected and `now <= policyOfflineGraceUntilSec`: keep enforcing cached policy (hybrid fail-open window)
- After `policyOfflineGraceUntilSec`: fail-closed (`DENY policy_stale_offline`)

## Meter Event Contract

```json
{
  "eventId": "evt_001",
  "workspaceId": "ws_abc",
  "seatId": "seat_1",
  "tool": "wiki_search",
  "atSec": 1760950000,
  "decision": "ALLOW_WITH_WARNING",
  "reasonCodes": ["usage_warning_100", "time_grace"],
  "usage": {
    "unit": "tool_call",
    "delta": 1
  },
  "policyId": "pol_2026_04_20_001",
  "leaseJti": "lease-123",
  "prevHash": "...",
  "hash": "..."
}
```

## Platform APIs (v1)

1. `POST /v1/policies/issue`
- Input: workspace/seat states, usage limits, time windows
- Output: signed policy snapshot

2. `POST /v1/leases/issue` (existing)
- Input: workspace/customer + seat + ttl
- Output: lease token

3. `POST /v1/policies/sync`
- Input: current `policyId`
- Output: latest signed policy snapshot or `not_modified`

4. `POST /v1/meter/upload`
- Input: batch of chained meter events
- Output: accepted range + ack

5. `GET /v1/usage/summary`
- Output: billable usage by workspace/seat/tool/window

## Revocation and Renewal Semantics

- Workspace revoke: set `workspacePolicy.mode = DISABLED` in next policy snapshot
- Seat revoke: set `seatPolicy.seats[seatId].mode = DISABLED` in next policy snapshot
- Renew: issue next lease + policy snapshot with extended time window and continued counters

No separate push requirement in air-gapped mode. Revocation takes effect on next sync or when current lease/policy window ends.

## End-to-End Value Demo (v1)

1. Issue lease + policy for workspace/seat
2. Receiver performs tool calls
3. Usage reaches 100%, warnings appear
4. Usage reaches 121% or time expires past grace, hard stop enforced
5. Renew policy/lease
6. Receiver syncs and resumes operation
7. Platform usage summary shows billable totals

## Testing Strategy (v1)

1. Unit tests
- time intersection logic
- usage threshold transitions
- decision engine precedence

2. Integration tests
- receiver enforcement against signed policy
- offline grace window then fail-closed
- revoke/renew across sync boundary

3. E2E script
- full value loop from issue -> use -> warn -> stop -> renew -> continue

## Risks

- Clock drift at receiver can misclassify time state
- Delayed sync can postpone revoke enforcement
- Policy/lease mismatch handling must be explicit

## Open Questions (deferred)

- Should usage windows support calendar reset and rolling windows simultaneously?
- Should partial seat group policies exist (tags/roles) in v2?
