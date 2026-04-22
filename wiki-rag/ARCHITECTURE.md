# Wiki RAG Architecture (Bun + SQLite)

## Goal
Build a lightweight local Markdown query system that can ship as a Bun-compiled executable, with a clean path from keyword search to semantic and graph-assisted retrieval.

## Non-Goals (v1)
- Distributed indexing or multi-tenant server mode
- Heavy Python GraphRAG pipelines
- Cloud-only vector databases

## Core Principles
- Local-first: all indexing and querying run on-device.
- Small surface area: Bun runtime + SQLite file + optional extension binary.
- Degrade gracefully: lexical-only mode must still work if embeddings or vector extension are unavailable.
- Deterministic artifacts: reproducible index outputs from the same Markdown corpus.

## High-Level Components

1. `wiki-rag` CLI (Bun)
- Commands:
  - `index` (build/refresh index)
  - `query` (answer/search)
  - `doctor` (environment + extension checks)
  - `stats` (index metrics)

2. Content Loader
- Recursively scans `.md` / `.mdx`
- Honors `.gitignore` and explicit include/exclude globs
- Extracts:
  - file path
  - title/heading hierarchy
  - frontmatter metadata
  - paragraph/chunk text

3. Chunker
- Heading-aware splitting first, token/length fallback second
- Stable chunk IDs via hash:
  - `sha256(relative_path + heading_path + normalized_text)`
- Emits offsets to support source trace-back

4. SQLite Storage (single DB file)
- Uses `bun:sqlite`
- FTS5 for lexical retrieval
- Metadata + optional graph edges in normalized tables
- Optional vector table via `sqlite-vec` extension

5. Retrieval Orchestrator
- Query rewrite + normalization
- Hybrid retrieval:
  - lexical (FTS BM25)
  - semantic (vector KNN, if enabled)
  - optional graph expansion (related entities/docs)
- Score fusion + rerank

6. Answer Composer
- Returns either:
  - ranked snippets with citations, or
  - LLM-ready context bundle
- Always includes source path + chunk ID + heading path

## Data Model (SQLite)

### `documents`
- `doc_id TEXT PRIMARY KEY`
- `path TEXT UNIQUE NOT NULL`
- `title TEXT`
- `frontmatter_json TEXT`
- `mtime_ms INTEGER NOT NULL`
- `content_hash TEXT NOT NULL`

### `chunks`
- `chunk_id TEXT PRIMARY KEY`
- `doc_id TEXT NOT NULL`
- `heading_path TEXT`
- `ordinal INTEGER NOT NULL`
- `text TEXT NOT NULL`
- `token_estimate INTEGER`
- `start_offset INTEGER`
- `end_offset INTEGER`
- FK `doc_id -> documents.doc_id`

### `chunks_fts` (FTS5 virtual table)
- `chunk_id UNINDEXED`
- `text`
- `title`
- `heading_path`

### `embeddings` (optional)
- If `sqlite-vec` enabled: vector storage keyed by `chunk_id`
- If disabled: table exists but unused, system remains lexical-only

### `entities` (optional graph-lite)
- `entity_id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `type TEXT`

### `chunk_entity_edges` (optional graph-lite)
- `chunk_id TEXT NOT NULL`
- `entity_id TEXT NOT NULL`
- `weight REAL DEFAULT 1.0`

## Indexing Pipeline

1. Discover files
- Build file set from roots + globs
- Skip unchanged files via `(mtime_ms, content_hash)`

2. Parse Markdown
- Extract headings + frontmatter + body
- Normalize whitespace while preserving source offsets

3. Generate chunks
- Heading-aware chunk boundaries
- Enforce target/max size constraints

4. Persist core tables
- Upsert `documents`
- Replace changed doc chunks atomically in transaction
- Refresh `chunks_fts`

5. Optional embedding phase
- Batch embed new/changed chunks
- Upsert vector rows

6. Optional graph-lite phase
- Entity extraction (rule-based or model-based)
- Upsert entities + chunk edges

## Query Pipeline

1. Parse query
- Normalize punctuation/case
- Detect mode: `lexical`, `hybrid`, `graph`

2. Retrieve candidates
- Lexical top-K from FTS5
- Semantic top-K from vectors (if available)
- Optional graph expansion from linked entities/chunks

3. Fuse scores
- Weighted reciprocal rank fusion (RRF)
- Default weights:
  - lexical: 0.5
  - semantic: 0.4
  - graph: 0.1

4. Build response
- Return top-N snippets + citations
- Optional synthesized answer from selected context

## Bun Packaging Strategy

1. Primary target: single executable with `bun build --compile`
2. Embed static assets (prompt templates, defaults) with `with { type: "file" }`
3. Keep runtime-write artifacts external:
- `wiki-rag.db`
- logs/cache
4. `sqlite-vec` extension loading:
- Try `db.loadExtension(path)` when configured
- If load fails, auto-fallback to lexical mode and warn once

## Modes

### Mode A: Minimal (recommended bootstrap)
- FTS5 only
- No embedding dependency
- Fast and smallest operational footprint

### Mode B: Hybrid
- FTS5 + `sqlite-vec`
- Better semantic recall while staying local

### Mode C: Graph-lite
- Hybrid + entity edges
- Lightweight GraphRAG flavor without Python-heavy pipelines

## CLI Contract (proposed)
- `wiki-rag index --root ./docs --db ./.wiki/wiki-rag.db`
- `wiki-rag query "how does licensing TTL work" --db ./.wiki/wiki-rag.db --top 8`
- `wiki-rag doctor --db ./.wiki/wiki-rag.db`
- `wiki-rag stats --db ./.wiki/wiki-rag.db --json`

## Observability
- Store index run stats:
  - files scanned
  - files changed
  - chunks written
  - embedding latency
  - total duration
- Query stats:
  - mode used
  - retrieval latency by stage
  - candidate counts per retriever

## Security + Safety
- No outbound network required for lexical mode
- Embedding provider must be explicit (local model or remote API)
- Never execute Markdown content
- Enforce max file/chunk size to avoid memory spikes

## Rollout Plan

1. Milestone 1: lexical-only
- `documents`, `chunks`, `chunks_fts`
- `index/query/stats` commands

2. Milestone 2: hybrid semantic
- embedding adapter interface
- optional `sqlite-vec` path + fallback behavior

3. Milestone 3: graph-lite
- `entities`, `chunk_entity_edges`
- graph expansion in retrieval orchestrator

4. Milestone 4: bundle hardening
- Bun compile target(s)
- platform packaging + smoke tests

## Why This Over Full GraphRAG
- Lower complexity and operational cost
- Better fit for Bun single-binary workflows
- Keeps a clean upgrade path toward richer graph retrieval when needed
