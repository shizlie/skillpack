# skillpack — Project Guide for Claude

NOTE: Provide concise, focused responses. Skip non-essential context, and keep examples minimal. Use /cavemen, and assume the readers are stupid.

## What this is

skillpack is an open-source SDK + commerce layer that turns AI skills into **signed, license-gated, offline-metered binaries** for vertical AI vendors selling into regulated on-prem environments (healthcare, legal, finance, defense). Vendors bring the skill; skillpack handles signing, licensing, usage metering, and a vendor dashboard.

The full design lives at:
`~/.gstack/projects/hcproduct-verticalAI/baoharryngo-master-design-20260418-233940.md`

That doc is the source of truth for product scope, architecture, threat model, success criteria, and the assignment. Read it before making any non-trivial change.

## Status

Pre-product. Pre-revenue. Design APPROVED. Week-1 foundations and CLI/runtime integration are implemented. Monorepo restructured into `packages/` (pure libs) and `apps/` (deployables). Dashboard worker with Clerk auth shipped, including a hosted billing cockpit for pricing rules, invoice drafts, and payment handoffs. Current task: keep production storage, operations, billing, and release paths publishable.

## Package layout

```
packages/          pure shared libraries
  core/            @skillpack/core — business logic, storage (license-server renamed)
  crypto/          @skillpack/crypto — Ed25519 signing
  protocol/        @skillpack/protocol — bundle format + schema
  tsa/             @skillpack/tsa — timestamp authority client
  runtime/         @skillpack/runtime — embedded skill runtime (.mcpb)

apps/              deployable units
  api/             @skillpack/api — CF Worker REST API (was license-server-worker)
  dashboard/       @skillpack/dashboard — CF Worker BFF + Clerk auth UI
  cli/             @skillpack/cli — vendor-side CLI
  wiki-mcp/        @skillpack/wiki-mcp — demo wiki MCP server
```

When adding code: pure business logic → `packages/core`. CF Worker glue → `apps/api`. New deployable → `apps/`.

## Architecture (v1)

- **Vendor-side CLI:** Bun + TypeScript. `skillpack init | build | sign | publish`
- **Embedded skill runtime:** Bun. Ships inside the .mcpb bundle. Verifies license, enforces TTL + grace, writes usage log.
- **Signing:** Ed25519 via `@noble/ed25519`. Bundle = stock `.mcpb` ZIP + `manifest.sha256` + detached `signature.bin` + embedded `license.json`
- **License model:** lease-based, 30d default TTL, 72h grace after expiry. Revoke = don't re-issue on next refresh.
- **Tamper-resistant meter:** HMAC-chained append-only log. HMAC key rotates per lease refresh.
- **License server, two flavors, both ship v1:**
    - Hosted: Hono on Cloudflare Workers + D1
    - Self-hosted: Docker image with embedded SQLite (mandatory for air-gapped customers)
- **Dashboard UI:** hosted Cloudflare Worker with Clerk auth and server-side API proxy. v1 exposes operator surfaces for commercial hierarchy, usage, TSA attestations, and billing handoffs while preserving CLI/self-host fallbacks.
- **Dashboard operating model:** dashboard should not assume every operation needs the backend. Preserve and design for detached-capable dashboard flows where the browser can inspect local/exported state, prepared artifacts, cached data, or operator-provided files without calling the hosted API. Use the backend only for operations that truly require hosted state mutation, hosted verification, or live sync.
- **Demo skill:** one — legal contract review (healthcare build deferred)

## Conventions

- **Bundle format = `.mcpb` only for v1.** Adapters (OpenAI Apps SDK, local Llama) come AFTER first design-partner LOI. Do not add format-agnostic abstractions speculatively.
- **One vertical demo skill for v1 (legal).** Healthcare = design-partner outreach target, not v1 build target.
- **No multi-tenant free tier** in v1. Hosted server = pilot use only until post-LOI.
- **Be honest about IP:** signing proves provenance + gates license. It does NOT obfuscate skill source. MCPB is a readable ZIP. Native bytecode-compile is v2.
- **Hard-revoke is wrong.** Lease-with-grace is the only model that works for hospital uptime requirements. Do not "simplify" this away.
- **Write tests around the threat model**, not just happy paths. Tampered HMAC chains, expired leases, clock-skew, broken signatures, CRL hits — these are the product, not edge cases.

## Out of scope for v1

- Accounting-grade dashboard finance workflows: tax, refunds, dunning, reconciliation, and payment webhook lifecycle automation
- Healthcare demo skill build
- Multi-seat/per-node licensing
- FedRAMP, SOC2 Type II, HIPAA BAA
- Bytecode/native obfuscation
- Payment webhook reconciliation and hosted customer portal flows
- Public docs site
- Python/TS authoring SDKs (CLI wraps MCPB)
- Free hosted tier / multi-tenant license server
- Out-of-band CRL push polling
- D1 rearchitecture for high-volume meter ingest
- LLM eval gate (no skillpack-owned prompt content in v1)

## Reviewer concerns (must resolve during implementation)

See "Reviewer Concerns" section in design doc. Major items: lease refresh API contract, KMS key injection flow, clock-skew defense, multi-seat license granularity, failed-call billing semantics.

## Critical gap to implement

One unresolved critical gap remains from eng-review: TSA outage for air-gapped customers with no sneakernet operator. Required mitigation in implementation:

- Emit TSA token expiry warnings from the license server (foundation contract implemented)
- Provide a manual time-attestation CLI escape hatch for incident response (foundation endpoint/contract implemented)
- Complete end-to-end incident workflow (operator runbook, persistence, and runtime enforcement behavior)

## gstack

- Use the `/browse` skill from gstack for all web browsing.
- Never use `mcp__claude-in-chrome__*` tools.
- Available skills: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:

- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
