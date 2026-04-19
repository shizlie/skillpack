# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [0.1.0.0] - 2026-04-19

### Added

- Added `@skillpack/cli` workspace package with `skillpack` command surface for lease issue/verify and manual TSA attestation flows.
- Added `@skillpack/runtime` workspace package for lease verification, grace handling, and meter-chain event emission.
- Added root-level `ObsidianGraph` query utility with SQLite-backed wiki-link ingestion and context expansion.
- Added tests for CLI/runtime behavior and regression coverage for `ObsidianGraph`.

### Changed

- Updated workspace lockfile to include new `@skillpack/cli` and `@skillpack/runtime` packages.
- Added release-pipeline follow-up TODO for distributable artifacts (`packages/cli`, `packages/runtime`).
