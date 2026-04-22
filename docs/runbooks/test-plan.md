# E2E Test Plan (Automation + Operator/Vendor Validation)

## Objective

Validate the full shipped user journey end-to-end with automation first:

1. Vendor issues and verifies leases.
2. TSA outage fallback works with manual attestation.
3. Runtime enforces lease + TSA policy correctly.
4. Wiki is exposed via MCP tools/resources and is queryable.

This runbook covers automation and operator/vendor validation before handoff.
Receiver-side acceptance after bundle delivery is documented separately in:
`docs/runbooks/receiver-verify-install.md`.

## Scope

In scope:

- `@skillpack/cli`
- `@skillpack/license-server`
- `@skillpack/license-server-worker` (Cloudflare Worker + D1 storage)
- `@skillpack/protocol` (commercial contract validation)
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

## Personas and ownership

- Automation (CI/agents): runs deterministic gates (`bun test`, e2e, parity/fallback/resilience).
- Operator/Vendor: runs manual pre-handoff checks using CLI and runtime commands.
- Receiver end user: validates delivered experience in Claude with prompt-based UAT.
  Receiver UAT is out of scope for this runbook and lives in `receiver-verify-install.md`.

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

### Journey D: Commercial hierarchy + Cloudflare D1 (no wrangler required)

Tests the provider→customer→workspace management API and meter ingest pipeline backed by D1 storage. No `wrangler dev` needed — the worker exports a plain `fetch(request, env)` function, so tests call it directly with a mock D1 adapter backed by Bun's in-memory SQLite.

1. Import worker and supply mock env: `{ DB: createTestD1Database(), SKILLPACK_MANAGEMENT_API_KEY, SKILLPACK_SIGNING_PRIVATE_KEY_PEM, SKILLPACK_SIGNING_PUBLIC_KEY_PEM }`.
2. POST `/v1/providers` → assert provider created.
3. POST `/v1/providers/:id/customers` → assert customer bound to provider.
4. POST `/v1/workspaces` → assert workspace status `ACTIVE`.
5. POST `/v1/meter/upload` → assert `accepted: true`, correct `ack.count`.
6. GET `/v1/usage/summary` → assert totals aggregated by dimension.
7. POST `/v1/policies/issue` + POST `/v1/policies/sync` → assert policy delivered/cached.

Negative paths covered:
- `POST /v1/providers/:id/customers` with unknown providerId → 400 `provider_not_found`
- `POST /v1/workspaces` with unknown customerId → 400 `customer_not_found`
- `POST /v1/workspaces` re-issued with different provider/customer for same workspaceId → 400 `workspace_identity_mismatch`
- All management routes without `x-api-key` → 401

Mock D1 pattern (no wrangler):

```js
import worker from "../src/index.js";

const env = {
  DB: createTestD1Database(),            // Bun SQLite wrapped in D1 interface
  SKILLPACK_MANAGEMENT_API_KEY: "key",
  SKILLPACK_SIGNING_PRIVATE_KEY_PEM: privateKeyPem,
  SKILLPACK_SIGNING_PUBLIC_KEY_PEM: publicKeyPem,
};
const res = await worker.fetch(new Request("http://local/v1/providers", { ... }), env);
```

The `createTestD1Database()` helper wraps `new Database(":memory:")` with `{ prepare, exec, batch }` matching the D1 API. Lives in `packages/license-server-worker/test/worker.test.js`.

Gate command:

```bash
bun test packages/license-server-worker
```

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
5. [x] Add Journey D: commercial hierarchy + D1 worker tests (no wrangler needed).
6. [x] Add `"test": "bun test"` to `packages/license-server-worker/package.json`.

## Skill Distribution Test Matrix (`verticals/laws-consultant`)

### Unit tests

- Validate `SKILL.md` frontmatter shape (`name`, `description`) and naming consistency with folder.
- Validate bundle metadata after build (`manifest.json`, `manifest.sha256`, `signature.bin`, `license.json` present).

Suggested command:

```bash
bun test packages/cli/test/cli.test.js
```

### Integration tests

- Run wiki MCP server against `verticals/laws-consultant/wiki`.
- Verify `wiki_search` and `wiki_read_page` return expected pages for Singapore regulatory queries.

Suggested command:

```bash
bun test packages/wiki-mcp/test/wiki-mcp.test.js
```

### E2E tests

- Build signed skill bundle from vertical root using `bun run bundle:laws-consultant`.
- Execute cross-package journey (`license issue/verify`, TSA manual attestation, wiki MCP retrieval).

Suggested command:

```bash
bun run bundle:laws-consultant && bun run test:e2e
```

### Operator/Vendor UAT (manual pre-handoff)

- Validate generated `.mcpb` and runtime behavior before sending bundle to receiver.
- Ensure receiver can retrieve lease/context from runtime via `wiki_runtime_info`
  (bundle version, lease mode, seat, workspace/policy IDs when available).
- Run 5 representative consultant prompts:
  - PDPA breach notification obligations
  - CII obligations under Cybersecurity Act
  - Computer Misuse Act unauthorized access scenario
  - MAS TRM control mapping request
  - Cross-statute compliance checklist request
- Accept only if responses:
  - cite wiki evidence pages,
  - separate law vs guidance,
  - include risk notes and next actions,
  - avoid unqualified legal-advice claims,
  - explicitly flag non-wiki claims (memory/external) as non-wiki.

Receiver-facing UAT flow (post-delivery): `docs/runbooks/receiver-verify-install.md` Step 6.

### Wiki-RAG rollout UAT matrix (runtime + fallback)

Run from repo root unless noted.

1. Build release bundle:

```bash
bun run bundle:laws-consultant
```

2. Run regression gates:

```bash
bun run test:wiki-rag
bun run test:wiki-rag-fallback
bun run test:wiki-rag-parity
bun run test:wiki-rag-resilience
bun test packages/wiki-mcp/test/wiki-mcp.test.js
```

3. Verify bundle embeds preindex artifacts:

```bash
unzip -l dist/skills/laws-consultant-<version>.mcpb | rg "wiki-rag|knowledge/wiki"
```

Expected:

- `skill/knowledge/wiki-rag.db`
- `skill/knowledge/wiki-rag.json`

4. Runtime behavior matrix:

- Legacy baseline:

```bash
printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wiki_search","arguments":{"query":"copyright","limit":2}}}\n' \
| RAG_ENGINE=legacy RAG_FAIL_OPEN=true node dist/skills/laws-consultant-<version>/runtime/server.mjs dist/skills/laws-consultant-<version>/laws-consultant-<version>.mcpb dist/skills/laws-consultant-<version>/laws-consultant-<version>.public.pem
```

- SQLite mode in release directory:

```bash
cd dist/skills/laws-consultant-<version>
printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wiki_search","arguments":{"query":"copyright","limit":2}}}\n' \
| RAG_ENGINE=sqlite RAG_FAIL_OPEN=true node runtime/server.mjs laws-consultant-<version>.mcpb laws-consultant-<version>.public.pem
```

- Fail-closed behavior:

```bash
printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wiki_search","arguments":{"query":"copyright","limit":2}}}\n' \
| RAG_ENGINE=sqlite RAG_FAIL_OPEN=false node runtime/server.mjs laws-consultant-<version>.mcpb laws-consultant-<version>.public.pem
```

Expected:

- `RAG_ENGINE=legacy`: returns normal results.
- `RAG_ENGINE=sqlite` + fail-open true: returns sqlite results; if sqlite initialization fails, returns legacy results with warning.
- `RAG_ENGINE=sqlite` + fail-open false: hard error on sqlite initialization/query failure.

5. Receiver-folder transfer simulation (same machine, separate folder):

```bash
VERSION="$(cat VERSION)"
RECEIVER_DIR="/tmp/receiver-test-$VERSION"

rm -rf "$RECEIVER_DIR"
mkdir -p "$RECEIVER_DIR"
cp "dist/skills/laws-consultant-$VERSION-bundle.tar.gz" "$RECEIVER_DIR/"

cd "$RECEIVER_DIR"
tar -xzf "laws-consultant-$VERSION-bundle.tar.gz"
cd "laws-consultant-$VERSION"

./runtime/receiver-verify-install.sh

printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"wiki_search","arguments":{"query":"copyright","limit":2}}}\n' \
| RAG_ENGINE=sqlite RAG_FAIL_OPEN=false node runtime/server.mjs "laws-consultant-$VERSION.mcpb" "laws-consultant-$VERSION.public.pem"
```

Expected:

- receiver script passes all verification/install steps.
- sqlite query succeeds from extracted receiver folder (no dependency on repo-local paths).

Reference: `docs/runbooks/receiver-verify-install.md` (Step 1 and Step 1B).

## Decision

For the current shipped surface, **Playwright/browser is not the primary E2E path**.
Primary E2E is protocol/CLI/MCP automation, fully runnable by AI agents and code runners.
