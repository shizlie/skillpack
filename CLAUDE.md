# skillpack — Project Guide for Claude

## What this is

skillpack is an open-source SDK + commerce layer that turns AI skills into **signed, license-gated, offline-metered binaries** for vertical AI vendors selling into regulated on-prem environments (healthcare, legal, finance, defense). Vendors bring the skill; skillpack handles signing, licensing, usage metering, and a vendor dashboard.

The full design lives at:
`~/.gstack/projects/hcproduct-verticalAI/baoharryngo-master-design-20260418-233940.md`

That doc is the source of truth for product scope, architecture, threat model, success criteria, and the assignment. Read it before making any non-trivial change.

## Status

Pre-product. Pre-revenue. Design APPROVED. Implementation started with `packages/crypto` foundation. Current task: complete week-1 crypto primitives and then split into lane-based build execution.

## Architecture (v1)

- **Vendor-side CLI:** Bun + TypeScript. `skillpack init | build | sign | publish`
- **Embedded skill runtime:** Bun. Ships inside the .mcpb bundle. Verifies license, enforces TTL + grace, writes usage log.
- **Signing:** Ed25519 via `@noble/ed25519`. Bundle = stock `.mcpb` ZIP + `manifest.sha256` + detached `signature.bin` + embedded `license.json`
- **License model:** lease-based, 30d default TTL, 72h grace after expiry. Revoke = don't re-issue on next refresh.
- **Tamper-resistant meter:** HMAC-chained append-only log. HMAC key rotates per lease refresh.
- **License server, two flavors, both ship v1:**
    - Hosted: Hono on Cloudflare Workers + D1
    - Self-hosted: Docker image with embedded SQLite (mandatory for air-gapped customers)
- **Dashboard UI:** deferred to post-LOI. v1 ships CLI + REST API only.
- **Demo skill:** one — legal contract review (healthcare build deferred)

## Conventions

- **Bundle format = `.mcpb` only for v1.** Adapters (OpenAI Apps SDK, local Llama) come AFTER first design-partner LOI. Do not add format-agnostic abstractions speculatively.
- **One vertical demo skill for v1 (legal).** Healthcare = design-partner outreach target, not v1 build target.
- **No multi-tenant free tier** in v1. Hosted server = pilot use only until post-LOI.
- **Be honest about IP:** signing proves provenance + gates license. It does NOT obfuscate skill source. MCPB is a readable ZIP. Native bytecode-compile is v2.
- **Hard-revoke is wrong.** Lease-with-grace is the only model that works for hospital uptime requirements. Do not "simplify" this away.
- **Write tests around the threat model**, not just happy paths. Tampered HMAC chains, expired leases, clock-skew, broken signatures, CRL hits — these are the product, not edge cases.

## Out of scope for v1

- Vendor dashboard UI
- Healthcare demo skill build
- Multi-seat/per-node licensing
- FedRAMP, SOC2 Type II, HIPAA BAA
- Bytecode/native obfuscation
- Stripe billing integration
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

- Emit TSA token expiry warnings from the license server
- Provide a manual time-attestation CLI escape hatch for incident response

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
