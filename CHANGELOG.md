# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [0.7.0.0] - 2026-06-02

### Added

- Declarative route table for the license server. All 22 management endpoints (providers, customers, workspaces, leases, policies, meter, usage, billing, TSA) are declared once in `packages/core/src/routes.js` and dispatched through a single `dispatch()` wrapper. Adding a new endpoint is a one-line table entry.
- Shared `packages/core/src/worker-auth` module that exports `readEnv`, `getClerkClient`, `isValidSharedManagementKey`, `getManagementAuthMode`, `addUpstreamAuthHeaders`, and friends. Both the API worker (`apps/api/src/index.js`) and the dashboard worker (`apps/dashboard/src/index.js`) import from a single source of truth; their private copies of these helpers are gone.
- Shared `packages/core/src/storage-contract` module that fronts a `createLeaseStore({ sql })` factory. The D1 and SQLite adapters are now ~25-line wrappers around the same schema and SQL — no more 800-line near-duplicate files.
- `apps/cli/src/descriptor.js` exports a `DESCRIPTOR` symbol that the CLI runner checks instead of duck-typing on `(required|buildRequest|exec)`. Resolves a runner↔commands import cycle by living in its own module.
- Dashboard UI decomposition. The 1,353-line `apps/dashboard/src/dashboard-ui.js` is now a re-export shim; live modules live under `apps/dashboard/src/ui/{index,api,formatters,render-html}.js` + `ui/render/{policy,usage,billing,tsa}.js` + `ui/styles.css`. A build-time pre-bundle (`scripts/build-dashboard.js`) keeps the runtime JS deployable to Cloudflare Workers.
- Runtime policy and crypto helpers now import from their canonical homes (`@skillpack/protocol`, `@skillpack/crypto`); the runtime-side shadows in `server.mjs` and `server-util.mjs` are gone.
- Test suite for the refactor: 7 new test files (`storage-contract.test.js`, `worker-auth.test.js`, `routes.test.js`, `dispatcher.test.js`, `route-table.test.js`, `no-duplicate-definitions.test.js`, `policy.test.js`) plus a table-driven rewrite of `cli.test.js`.

### Changed

- `bun test packages/ apps/` runs 427 tests across 30 files with 912 expects and passes in ~1 second.
- CLI's `runCommand` flows through a single 3-level descriptor table (`group → action → subAction`); `apps/cli/src/index.js` shrank from 700 lines to 37. Adding a subcommand is a descriptor entry, not a new function.
- `packages/core/src/server.js` shrank from 655 to 146 lines as routing moved to the declarative table. The legacy `if (request.method === X && url.pathname === Y)` dispatcher is gone.
- `apps/api/src/index.js` shrank from 235 to 118 lines; `apps/dashboard/src/index.js` from 215 to 164. Both lost their private auth helpers in favor of `@skillpack/core/worker-auth`.
- Route handler error envelopes now flow through `dispatch(handler, { errorEnvelope })`. 19 of 22 handlers lost their try/catch boilerplate; `uploadMeter` (3-path auth) and `getInvoice` (explicit 404) keep their own envelopes. Single point of change for future error-envelope policy.

### Fixed

- `getManagementAuthMode` now consults `SKILLPACK_API_AUTH_MODE` first (the canonical env var name) and falls back to the legacy `SKILLPACK_MANAGEMENT_AUTH_MODE`, preserving in-flight deployments that set only the legacy var.
- `getClerkClient` supports `requirePublishableKey: true` so the dashboard's session-auth path can require both `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` while the API worker remains publishable-key-optional.
- `apps/cli/src/commands.js` imports 7 helpers from `./arg-helpers.js` instead of carrying byte-for-byte duplicates (was caught by a code-quality re-audit).
- Runtime's `policy-enforcement.test.js` imports `validatePolicySnapshot` and `evaluatePolicyToolCallDecision` from `@skillpack/protocol` (the canonical implementation) instead of the shadow copy in `runtime/src/server.mjs`.
- A `no-duplicate-definitions` test now guards `verifyLeaseForRuntime` and the canonical crypto helpers from being re-declared in `runtime/src/server.mjs`.

## [Unreleased]

## [0.6.3.0] - 2026-05-01

### Added

- Clerk-backed management auth for hosted API deployments, with `shared-key`, `clerk`, and `hybrid` modes so hosted operators can use Clerk sessions while self-hosted and automation users can keep using `SKILLPACK_API_KEY`.
- Hosted smoke preflight that reports missing hosted URLs or Skillpack management auth before live verification.
- Expanded hosted smoke coverage for hierarchy setup, policy issue, meter upload, usage summary, billing invoice draft, and optional Clerk-authenticated dashboard proxy verification.
- Post-merge Cloudflare deployment checklist with terminal-first `bunx wrangler` commands.

### Changed

- Dashboard proxying now forwards Clerk bearer tokens to the API in Clerk/hybrid mode instead of requiring the Skillpack shared key as the only backend credential.
- Hosted deploy verification now runs as a smoke-only GitHub workflow after terminal deployment, without Cloudflare API token or account ID inputs.
- Hosted deploy manifest marks `SKILLPACK_API_KEY` as optional for Clerk/hybrid auth while keeping signing keys and Clerk secrets explicit.

## [0.6.2.0] - 2026-05-01

### Added

- Server-backed `skillpack license issue` support for hosted lease issuance, including TSA outage hints and ticket-scoped manual attestation embedding.
- Runtime `buildTsaPolicyFromLeaseResponse` helper so receivers can hydrate TSA policy directly from lease issue responses.

### Changed

- TSA outage continuity now uses a 4-hour default manual attestation window and ticket-scoped lookups instead of requiring runtime-side manual injection.
- TSA outage runbook and project docs now describe the reduced Autoplan scope and server-backed reissue flow.

### Fixed

- SQLite and D1 workspace upserts now reject provider/customer identity changes atomically, closing the `workspace_identity_mismatch` race window.
- `latest-attestation` and lease reissue flows now respect incident ticket IDs so stale attestations from older incidents are not reused.

## [0.6.1.0] - 2026-05-01

### Added

- Hosted dashboard billing cockpit for pricing rules, draft invoices, invoice listing, and manual/Dodo/Stripe handoff creation through the authenticated proxy.

## [0.6.0.0] - 2026-04-30

### Added

- Billing protocol contracts for pricing rules, draft invoices, and payment handoff requests.
- Billing core that rates accepted usage against active pricing rules, applies included units and minimum charges, and persists draft invoices with line-item JSON.
- Management API routes for pricing-rule creation/listing, draft invoice creation/listing, and invoice payment handoff.
- CLI billing commands for creating pricing rules, drafting invoices, and creating payment handoffs.
- Manual, Dodo Payments, and Stripe payment provider adapters behind a registry so vendors can self-collect or drop in hosted checkout.
- SQLite and D1 billing tables, including a standalone D1 migration for existing deployments.

### Fixed

- Payment adapters now skip zero-payable invoice lines and reject checkout for invoices with no payable lines, preventing accidental minimum-quantity overcharges.

## [0.5.0.1] - 2026-04-24

### Added

- Hosted control-plane deploy manifest (`deploy/hosted-control-plane.manifest.json`) plus deploy and smoke helpers for the real two-worker layout: `apps/api` and `apps/dashboard`.
- Bundle-local runtime meter helper modules (`runtime-meter`, `meter-store`, `local-meter-client`, `direct-upload-transport`) with focused tests and release/source artifact coverage.
- Local Cloudflare worker-pair smoke coverage for direct-mode metering, including lease issue, policy issue, runtime tool execution, and usage summary verification without manual `meter upload`.

### Changed

- Hosted deploy wiring is now manifest-driven so API/dashboard public bindings stay aligned across CI, local smoke, and production deployment.
- Runtime direct-mode metering now writes to the local spool first and flushes in the background with batched retry behavior, so control-plane latency does not block normal tool usage.
- Hosted deploy docs and runbooks now describe the actual `apps/api` + `apps/dashboard` layout, required production bindings, and direct-mode verification flow.
- Release packaging now includes the extracted runtime meter helper modules inside the runtime source artifact.

### Fixed

- `POST /v1/leases/issue` once again supports legacy callers while still enforcing the full commercial context for direct-mode leases.
- `POST /v1/meter/upload` now derives accepted commercial identity from the signed lease token (`x-skillpack-lease-token`) instead of trusting client-supplied upload context.
- Hosted smoke checks now fail fast when dashboard auth/config bindings are missing, reducing config drift between local `.dev.vars` and production.

## [0.5.0.0] - 2026-04-22

### Added

- Dashboard Cloudflare Worker (`apps/dashboard`) with Clerk authentication and BFF proxy. Operators can now authenticate via Clerk and manage licenses through a browser UI backed by the API worker.
- REST list/read endpoints for the commercial hierarchy: `GET /v1/providers`, `GET /v1/customers`, `GET /v1/workspaces`, and `GET /v1/tsa/manual-attestations` with optional filter parameters.
- Parameterized SQL filters for `listManualAttestations` in both SQLite and D1 storage — WHERE clauses pushed to DB instead of in-memory filtering.
- Storage filter unit tests for attestation queries (SQLite + D1): 14 new tests covering no-filter, single-field, combined AND, empty result, and NULL-filter cases.

### Changed

- Monorepo restructured into `packages/` (pure shared libraries) and `apps/` (deployable units). `packages/license-server` → `packages/core`, `packages/license-server-worker` → `apps/api`, `packages/cli` → `apps/cli`, `packages/wiki-mcp` → `apps/wiki-mcp`.
- CORS origin handling in the API worker now correctly returns `*` when `SKILLPACK_DASHBOARD_ORIGIN` is not configured (previously reflected the incoming `Origin` header, which could cause cache poisoning).

### Fixed

- `POST /v1/leases/issue` is now management-key-gated on hosted servers. Previously any caller could issue signed lease tokens without authentication.
- Dashboard proxy path stripping now uses `slice` and rejects paths containing `..`, preventing path traversal to unintended upstream routes.
- E2E and release workflow paths updated to match the new monorepo layout.

## [0.4.0.0] - 2026-04-22

### Added

- **`@skillpack/license-server-worker`** — new Cloudflare Worker package. Wraps the license server behind a Worker + D1 binding so vendors can deploy to Cloudflare's edge with zero infrastructure. Supports direct `worker.fetch(request, env)` testing without `wrangler dev`.
- **Commercial hierarchy API** — provider/customer/workspace management endpoints (`POST /v1/providers`, `POST /v1/providers/:id/customers`, `POST /v1/workspaces`) with full hierarchy enforcement: customer must belong to provider, workspace must bind to a known customer, re-assigning a workspace to a different provider/customer is rejected with `workspace_identity_mismatch`.
- **Cloudflare D1 storage adapter** (`packages/license-server/src/storage-d1.js`) — full parity with the SQLite adapter, backed by D1's SQL API. Includes idempotent meter event ingest via `INSERT OR IGNORE` with a composite `UNIQUE(event_id, event_seq, lease_jti)` dedup constraint.
- **Protocol constants** `USAGE_UNIT_TOOL_CALL` and `WORKSPACE_STATUS_ACTIVE` exported from `@skillpack/protocol`, replacing inline string literals across all storage adapters.
- **`wiki-rag-utils.mjs`** extracted from `runtime/src/server.mjs` — shared module for RAG engine configuration (`DEFAULT_LIMIT`, `MAX_LIMIT`, `SQLITE_ENGINE`, `LEGACY_ENGINE`, `parseBool`, `clampLimit`, `toPageId`, `normalizeSqliteRows`, `readWikiEngineConfig`).
- **CLI commercial commands** — `provider create`, `customer create`, `workspace create`, `meter upload` subcommands for managing the commercial hierarchy from the terminal.
- **Journey D** added to `docs/runbooks/test-plan.md` — documents the commercial hierarchy + D1 test pattern with a mock D1 adapter backed by Bun in-memory SQLite, requiring no `wrangler dev`.

### Changed

- **TSA routes auth-hardened** — `POST /v1/tsa/manual-attest` and `GET /v1/tsa/manual-attestations/latest` now require the management API key (`x-api-key`), consistent with all other management routes.
- **Worker handler caching** — switched from module-level singleton to `WeakMap` keyed on `env`. Matches CF Worker isolate semantics (stable `env` reference per isolate lifetime) and gives correct test isolation (each test creates a new `env` object).
- **Management API key comparison** now uses SHA-256 digest comparison via `crypto.timingSafeEqual` to avoid leaking key length via timing.
- **Meter upload error response** — storage failures now return `{ accepted: false, error: "meter_batch_failed", retryable: true }` with HTTP 500, distinct from validation errors (HTTP 400). Meter upload is idempotent: safe to retry the entire file on failure.
- **`eventId` encoding** uses `encodeURIComponent` on each composite segment to prevent colon-collision when workspace or seat IDs contain `:`.

## [0.3.0.1] - 2026-04-22

### Added

- Added a new `wiki-rag` module (`chunker`, `schema`, `indexer`, `retriever`, `cli`) for local Bun + SQLite retrieval with lexical-first behavior.
- Added comprehensive `wiki-rag` tests (`chunker`, `indexer`, `retriever`, `cli`, and `e2e`) and package scripts (`test:wiki-rag`, `wiki-rag`).
- Added runtime/MCP `wiki_runtime_info` tool support to expose bundle/runtime metadata (bundle version, lease mode, seat/workspace/policy context when available).
- Added runtime-side retrieval metadata in `wiki_search` responses to surface engine path (`sqlite` vs `legacy`) and fallback reasons.

### Changed

- Updated `laws-consultant` skill instructions to require runtime-context display and strict per-claim provenance labels (`WIKI`, `NON-WIKI: model memory`, `NON-WIKI: external`) with citation method.
- Updated receiver and operator runbooks (`receiver-verify-install`, `test-plan`) to include receiver-realistic UAT for runtime metadata/provenance verification.
- Updated runtime fallback wiring to keep sqlite-first rollout with mature fail-open legacy fallback.

### Fixed

- Fixed merge compatibility and schema/index test integration for `wiki-rag` after rebasing with `main`.
- Fixed receiver runbook command/config snippets to be version-parameterized and corrected malformed MCP config example output.

## [0.3.0.0] - 2026-04-20

### Added

- Added `packages/protocol/src/policy.js` — canonical policy engine with `evaluatePolicyDecision`, `evaluateUsageState`, `evaluateTimeState`, `evaluateEffectiveTimeWindow`, and `validatePolicySnapshot`. Exported from `@skillpack/protocol`.
- Added `evaluatePolicyToolCallDecision` to the runtime — enforces workspace, seat, usage, and time policy at every `tool_call`. Policy snapshot is loaded only after Ed25519 manifest signature verification (`policy.json` must appear in `manifest.files`).
- Added `POST /v1/policies/issue` and `POST /v1/policies/sync` to the license server — vendors push policy snapshots; receivers pull incremental updates.
- Added `POST /v1/meter/upload` and `GET /v1/usage/summary` — operators upload batched meter events and query aggregate usage.
- Added `skillpack policy issue|sync` and `skillpack meter upload|usage summary` CLI commands.
- Added `verticals/laws-consultant/distribution/policy.dev.json` — dev policy with 500-call budgets for demo workspace.
- Added `scripts/demo-policy-loop.sh` — deterministic local demo of the full enforcement loop (issue policy → set tight budget → exhaust budget → observe degraded mode → hard stop).
- Added `docs/runbooks/policy-loop-demo.md` — operator guide for the policy loop demo.

### Changed

- Runtime persists `toolUsageBySeat` to `meter-state.json` so per-seat tool budgets survive server restarts.
- `bundle-laws-consultant.mjs` now copies `policy.dev.json` into the bundle input directory so policy is covered by the manifest signature.
- Extended `test-receiver-e2e.sh` with step 6 (meter continuity) and step 6b (tampered-bundle rejection). Fixed duplicate section label 3b→3d.
- Warning-only degraded mode: `ALLOW_WITH_WARNING` at 100–120% usage, `DENY` beyond 120% (strictly greater).

### Fixed

- Policy snapshot was previously loaded before manifest verification — moved load to after signature check with manifest-entry guard.

## [0.2.0.0] - 2026-04-19

### Added

- Added `packages/runtime/src/server.mjs` — self-contained MCP stdio server that extracts the `.mcpb` bundle, verifies the Ed25519 lease token, serves wiki knowledge via `wiki_search` and `wiki_read_page` tools, and writes HMAC-chained meter events per call.
- Added `scripts/bundle-laws-consultant.mjs` — one-command vendor build script: generates or reuses Ed25519 keypair, issues a dev lease, stages bundle content, signs with `@skillpack/cli`, produces release folder and transfer tarball with `.sha256` sidecar.
- Added `scripts/test-receiver-e2e.sh` — automated receiver-side E2E suite covering happy path, key pinning, 4 tamper tests, tarball sidecar integrity, and optional Docker fresh-machine test.
- Added `docs/runbooks/receiver-verify-install.md` — full 6-step receiver guide: rebuild, local simulation, key pinning, Docker, tamper tests, MCP config, and Claude Code verification.
- Added `verticals/laws-consultant/SKILL.md` — laws-consultant skill guide for Claude Code with PDPA/CMA wiki grounding instructions.
- Added `graph-rag/` — Obsidian-style wiki graph query utility (moved from repo root to subdirectory).
- Added `bun run bundle:laws-consultant` and `bun run test:receiver-e2e` package scripts.

### Changed

- Moved `ObsidianGraph` and its tests from repo root into `graph-rag/` subdirectory; updated import paths.
- Updated `.gitignore` to track `dist/skills/**` release artifacts (opt-in, commit-manually workflow) while excluding private keys and dev license files.
- Updated README with bundle command reference, release folder structure, and receiver verification instructions.
- Removed `TEST_PLAN.md` (superseded by `docs/runbooks/` and the automated E2E suite).

## [0.1.0.0] - 2026-04-19

### Added

- Added `@skillpack/cli` workspace package with `skillpack` command surface for lease issue/verify and manual TSA attestation flows.
- Added `@skillpack/runtime` workspace package for lease verification, grace handling, and meter-chain event emission.
- Added root-level `ObsidianGraph` query utility with SQLite-backed wiki-link ingestion and context expansion.
- Added tests for CLI/runtime behavior and regression coverage for `ObsidianGraph`.
- Added `@skillpack/wiki-mcp` workspace package exposing wiki content via MCP `tools` and `resources`.
- Added `skillpack-wiki-mcp` stdio server CLI with support for `initialize`, `tools/list`, `tools/call`, `resources/list`, and `resources/read`.
- Added wiki MCP tests covering page listing/reading/search and MCP request handling.
- Added `e2e/full-journey.test.js` covering end-to-end journeys for license lifecycle, TSA outage fallback, and wiki MCP stdio flows.
- Added root scripts `test:unit` and `test:e2e` to separate fast package tests from cross-package E2E flows.
- Added local scripts and test harness support for `test:unit` and `test:e2e`; CI workflow wiring deferred.
- Added `skillpack bundle build` CLI command to package skills as `.mcpb` artifacts with manifest, hash file, optional embedded license, and optional detached signature.
- Added CLI test coverage for `.mcpb` bundle artifact generation.

### Changed

- Updated workspace lockfile to include new `@skillpack/cli` and `@skillpack/runtime` packages.
- Added release-pipeline follow-up TODO for distributable artifacts (`packages/cli`, `packages/runtime`).
- Marked "Expose the WIKI via MCP" as complete in TODOs and updated README with usage/docs.
