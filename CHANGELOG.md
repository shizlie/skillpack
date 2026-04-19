# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

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
