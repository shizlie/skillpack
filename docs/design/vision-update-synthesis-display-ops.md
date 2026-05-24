---
status: proposal
target: VISION.html
created: 2026-05-23
---

# Vision update — Synthesizer component, identity convention, ops chips

This proposal adds three concrete elements to VISION.html, drawn from a pattern observed across one internal back-office deployment and one external regulated-buyer deployment: the gap between *what the ledger knows* and *what the corpus and UI surface*.

The three elements are independent and shippable in sequence. Each has a concrete contract and acceptance criteria so reviewers can argue about scope, not vibes.

---

## 1. Synthesizer (10th component)

### Problem

The ledger captures every accepted tool call, keyed on provider · customer · workspace · seat · skill · tool. The wiki ships as static markdown bundled in the vertical. There is currently no contract that connects the two: the creator never learns *which questions buyers' agents are silently asking that the corpus does not answer well*, and the corpus does not grow where buyers actually pull from it.

### Shape

A scheduled LLM job that:

- clusters recurring tool-call argument patterns from the ledger
- clusters wiki query patterns (search misses, low-confidence reads) from the local meter chain after sync
- proposes L2 synthesis pages (mid-level write-ups that connect raw L1 pages) back to the creator
- cites the raw events that motivated each proposal
- runs killswitched and cost-capped by default

The creator curates: apply (ship as next bundle release), edit, or reject. The eval gate must pass before "apply" is enabled. All proposal/apply transitions write SRE audit events.

### Contract

```
POST /v1/synthesis/proposals          # creator queries pending
POST /v1/synthesis/proposals/:id/apply
POST /v1/synthesis/proposals/:id/reject
GET  /v1/synthesis/proposals/:id/sources   # cited raw events
```

### Acceptance criteria

**Phase A — ledger plumbing (no LLM yet):**
- [ ] Ledger event schema carries `tool_call_pattern_hash` (sha256 of normalized args minus PII)
- [ ] Wiki MCP emits `wiki_query_event` records (query string, hit page slugs, hit confidence) into the local meter chain
- [ ] Server-side cron `synthesis-cluster` (weekly default) reads accepted events and produces a `synthesis_candidate.jsonl` artifact per skill
- [ ] `SYNTHESIS_ENABLED` env flag defaults `false`
- [ ] LLM cost cap per vendor per month (default $10), tracked and surfaced

**Phase B — proposal lifecycle:**
- [ ] `/v1/synthesis/proposals` endpoints implemented behind the existing API auth (Clerk or shared key)
- [ ] Each proposal record includes: skill_id, proposed page draft, source pattern cluster, cited raw event IDs, eval-score-required-to-apply
- [ ] Audit events `SYNTHESIS_PROPOSED` / `SYNTHESIS_APPLIED` / `SYNTHESIS_REJECTED`

**Phase C — dashboard surface:**
- [ ] Dashboard `/proposals` page lists pending proposals per skill
- [ ] Apply button disabled until eval suite passes the draft page
- [ ] Reject requires a one-line reason that goes into the audit event

---

## 2. Identity convention — `id` vs `display_name`

### Problem

Internal IDs (`prov-1`, `cust-1`, `inv-1`, `lease-jti-...`) currently appear in UI surfaces. Operators and buyers should never have to remember opaque tokens to navigate their own data. Internal IDs are an API contract, not a UX surface.

### Rule

Every first-class entity (provider, customer, workspace, seat, skill, bundle, lease, invoice) carries:

- `id` — opaque, stable forever, used by APIs, audit logs, and signed artifacts
- `display_name` — human-readable, editable by the entity owner, shown in every UI surface

`id` only surfaces in: API responses, raw audit log records, signed token payloads, debugging URLs. All user-facing copy — dashboard tables, invoice PDFs, email notifications, agent confirmations, hub listings — renders `display_name`.

### Acceptance criteria

**Phase A — schema + API:**
- [ ] Migrations add `display_name TEXT NOT NULL` to: `providers`, `customers`, `workspaces`, `seats`, `skills`, `bundles`, `invoices`
- [ ] Migration backfill: rows without a name get `<Entity> #<id>` as the default
- [ ] `PATCH /v1/{entity}/{id}/display-name` for the entity owner to rename
- [ ] Display name length and uniqueness rules documented per entity

**Phase B — dashboard:**
- [ ] Every table, drawer, and detail page in `apps/dashboard` reads `display_name`, not `id`
- [ ] Search box in dashboard matches `display_name` first, falls back to `id`
- [ ] Invoice PDF renderer uses `display_name` in header and line items

**Phase C — buyer surfaces:**
- [ ] Agent / MCP client confirmation strings show skill `display_name`, not `skill_id` or `bundle_id`
- [ ] Hub listing pages render `display_name` as the title; `id` is metadata

---

## 3. Operational chips on dashboard landing

### Problem

The dashboard shows tables and totals. It does not surface *what the operator needs to do today*. Today's open work — leases close to expiry, customers with expired TSA freshness, workspaces with stale sync, invoices waiting on payment handoff, synthesis proposals waiting on review — is buried inside multiple tables.

### Shape

A single row of operational chips on the dashboard landing page. Each chip is:

- a real-time count of items requiring operator attention
- click-through to a pre-filtered table view
- hidden when the count is zero (no noise)
- updatable on mount, ideally pushed via SSE or websocket later

### Initial chip set

| Chip | Counts |
|---|---|
| Leases expiring 7d | active leases with `expires_at - now() <= 7d` |
| TSA expired | customers where latest TSA token age exceeds policy max |
| Sync stale >24h | workspaces with no accepted meter upload in 24h |
| Invoices draft | draft invoices with no payment handoff |
| Proposals pending | synthesis proposals awaiting creator decision (links to §1) |

### Acceptance criteria

**Phase A — endpoint + chip row:**
- [ ] `GET /v1/dashboard/ops-counts` returns the five counts above, cached server-side (60s default)
- [ ] Dashboard landing renders chip row; zero counts hide
- [ ] Each chip is a link to the relevant table with the filter applied
- [ ] Mobile parity verified

**Phase B — real-time + digest:**
- [ ] Counts update without a manual page reload (SSE acceptable)
- [ ] Optional daily email digest when total ≥ 5 items pending, configurable

**Phase C — buyer-side analog:**
- [ ] Customer dashboard (when shipped) carries its own chips: skills expiring, updates available, errors last 7d

---

## Phase mapping

| Element | Phase A | Phase B | Phase C |
|---|---|---|---|
| 1. Synthesizer | ledger plumbing | proposal lifecycle | dashboard surface |
| 2. Identity convention | schema + API | dashboard | buyer surfaces |
| 3. Ops chips | endpoint + chip row | real-time + digest | buyer-side analog |

The three elements share a Phase A that can land together (schema migrations + new endpoints, no LLM dependency). Phase B for §1 introduces the LLM dependency and should be killswitched until eval coverage is in place. Phase C across all three is the buyer-facing polish layer.

---

## Out of scope for this proposal

- Eval suite design (referenced by §1 but owned by a separate proposal)
- Royalty split semantics for synthesis-driven page contributions
- Multi-language wiki support
- Federated synthesis across vendors

## Open questions for reviewers

1. Synthesizer LLM provider — assume Claude API, or contract for pluggable provider?
2. Identity convention — is there an existing internal name for `display_name` that this proposal should adopt instead?
3. Ops chips — is the five-chip set above the right initial cut, or should this start with three and grow?
