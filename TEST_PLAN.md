# E2E Test Plan (AI-First, Minimal Human)

## Objective

Validate the full shipped user journey end-to-end with automation first:

1. Vendor issues and verifies leases.
2. TSA outage fallback works with manual attestation.
3. Runtime enforces lease + TSA policy correctly.
4. Wiki is exposed via MCP tools/resources and is queryable.

Human involvement is limited to one-time environment setup only.

## Scope

In scope:

- `@skillpack/cli`
- `@skillpack/license-server`
- `@skillpack/runtime`
- `@skillpack/wiki-mcp`
- Wire-level interactions between them

Out of scope (current repo state):

- Dashboard/browser UI flows (none shipped)
- Real external TSA service integration
- Deployment platform smoke checks

## Test Strategy

Primary (default): code-runner automation (Bun tests + E2E harness).

Secondary (optional): agent-run browser automation with `browse` for visual evidence once UI exists.

Why this split:

- Current product surface is CLI/API/MCP over stdio, not web UI.
- Playwright/browser adds little value today vs deterministic protocol-level E2E.

## Full User Journey to Simulate

### Journey A: Normal license lifecycle

1. Start license server with in-memory store.
2. Issue lease via CLI/server.
3. Verify lease via CLI/server.
4. Execute runtime action with active lease.
5. Assert meter chain events emitted.

### Journey B: TSA outage incident lifecycle

1. Start license server with SQLite store.
2. Issue lease with expired TSA freshness signal.
3. Submit manual attestation (`skillpack tsa manual-attest`).
4. Retrieve latest attestation (`skillpack tsa latest-attestation`).
5. Execute runtime with `tsaPolicy` + attestation.
6. Assert runtime accepts only valid/fresh attestation and rejects stale/missing.

### Journey C: Wiki via MCP lifecycle

1. Start `skillpack-wiki-mcp` (stdio).
2. Send MCP `initialize`.
3. Send `tools/list` and `resources/list`.
4. Call `wiki_search`.
5. Call `wiki_read_page`.
6. Read `wiki://index` and `wiki://page/<slug>`.
7. Assert schema, content, and traversal protections.

## Automation Layers

### Layer 1: Contract/unit tests (already present)

- Keep existing package tests as the fast gate.

Command:

```bash
bun test
```

### Layer 2: Cross-package E2E tests (to add next)

Create `e2e/full-journey.test.js` (single black-box spec with 3 journeys above).

Requirements:

- Use temporary directories/files only.
- Spawn MCP stdio process for wiki tests.
- Avoid network calls outside localhost/file system.
- No snapshots or brittle timing assertions.

Gate command:

```bash
bun test e2e
```

### Layer 3: Agentic execution lane (optional, non-blocking)

Use `browse` only for:

- future UI flows
- visual regression evidence
- debug reproductions

Current status:

- Local `browse` binary requires one-time setup before use.
- Not required for pass/fail in current CI gate.

## Pass/Fail Criteria

Release-ready if all are true:

1. `bun test` passes.
2. `bun test e2e` passes.
3. No critical/high findings in `/review` on latest commit.
4. E2E artifacts (logs/json outputs) produced for failed runs.

## AI-First Execution Policy

### Fully AI-runnable

- All Layer 1 and Layer 2 tests
- PR review checks
- Local regression triage

### Human-required (setup only)

- One-time install/build of local browser tooling (`browse`) if needed later
- Secrets/prod credentials if future deployment tests are added

## CI/CD Integration Plan

Add a dedicated pipeline stage order:

1. `test:unit` → `bun test --filter ...` (or current package tests)
2. `test:e2e` → `bun test e2e`
3. `review` → automated diff review gate

On failure:

- Upload test logs + JSON outputs as artifacts.
- Do not require screenshots unless a browser/UI flow is under test.

## Near-Term Implementation Checklist

1. [x] Add `e2e/full-journey.test.js` covering Journeys A/B/C.
2. [x] Add `package.json` script: `"test:e2e": "bun test e2e"`.
3. [ ] Add CI workflow step for `test:e2e`.
4. [x] Keep `browse` lane documented as optional until UI exists.

## Decision

For the current shipped surface, **Playwright/browser is not the primary E2E path**.
Primary E2E is protocol/CLI/MCP automation, fully runnable by AI agents and code runners.
