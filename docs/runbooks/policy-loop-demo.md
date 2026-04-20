# Policy Loop Demo Runbook

Goal: show the value loop end-to-end in a deterministic local flow:
`issue -> use -> warn -> stop -> renew -> continue`.

This demo uses local in-memory handlers (no external services).

## Prerequisites

- Bun installed
- Repo root as current directory

## Run

```bash
./scripts/demo-policy-loop.sh
```

## Expected output

Exact PASS checkpoints from the script:

```text
Policy loop demo (deterministic local simulation)
PASS: policy issue v1
PASS: policy sync v1
PASS: use #1 allows
PASS: use #2 warns
PASS: use #3 stops
PASS: meter upload
PASS: usage summary (totalCalls=2)
PASS: policy renew (issue v2)
PASS: policy sync after renew
PASS: continue after renew
PASS: policy loop demo complete
```

If any checkpoint fails, the script prints `FAIL: ...` and exits non-zero.

## What this proves

- `skillpack policy issue` can publish a policy snapshot.
- `skillpack policy sync` can fetch the latest workspace policy.
- Usage transitions are enforced as designed:
  - `<100% budget` => allow
  - `100%-120%` => warning-only degradation (`ALLOW_WITH_WARNING`)
  - `>120%` => hard stop (`DENY`)
- `skillpack meter upload` and `skillpack usage summary` close the telemetry loop.
- Renewing policy budget restores service continuity.
