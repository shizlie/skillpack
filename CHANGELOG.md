# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [Unreleased]

### Added

- Extended release workflow to publish distributable CLI/runtime artifacts per tag release:
  - standalone Linux x64 binaries for `skillpack` CLI and runtime server
  - source tarballs for CLI dependency closure and runtime source
  - SHA-256 checksum files for all new artifacts
- Added end-user release install/verification guide in `README.md` for binary and source distribution paths.

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
