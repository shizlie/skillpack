# skillpack

Commerce layer for vertical AI skills shipped as compiled `.mcpb` bundles.

**Status:** pre-product. Design approved 2026-04-18. Week-1 foundations shipped (crypto, protocol, license-server, TSA contracts).

---

## What this is

A toolkit for vendors who sell AI skills into regulated, on-premise environments (hospitals, law firms, defense, finance) where:

- The buyer cannot send patient/client data to a hosted LLM
- The buyer runs local inference on their own hardware
- Remote MCP servers do not work (air-gapped or restricted egress)
- The vendor needs IP protection, license enforcement, and usage analytics — but cannot phone home on every call

skillpack gives vendors:

1. **A CLI** to bundle a skill into a signed `.mcpb` (Anthropic's MCP bundle format)
2. **An embedded runtime** that verifies the license lease offline, enforces TTL + grace, and writes a tamper-resistant usage log
3. **A license server** (hosted on Cloudflare Workers, or self-hosted via Docker for air-gapped customers) that issues leases and ingests meter logs

---

## Why

Markdown skills are blog posts. Anyone can fork them. There is no license, no meter, no revoke, no analytics.

For a hospital paying six figures for a radiology skill, "trust me, do not copy this `.md` file" is not a contract. For the vendor selling that skill, "I have no idea how often you ran it last quarter" is not a billing model.

Compiled `.mcpb` bundles fix the format. skillpack adds the commerce.

---

## Architecture (v1)

| Layer                        | Stack                                                              |
| ---------------------------- | ------------------------------------------------------------------ |
| Vendor CLI                   | Bun + TypeScript                                                   |
| Embedded runtime             | Node + `better-sqlite3` (Claude Desktop hosts MCPB via Node)      |
| Signing                      | Ed25519 via `@noble/ed25519`                                      |
| Licensing                    | Lease-based: 30d TTL, 72h grace. Not instant revoke.              |
| Metering                     | HMAC-chained append-only log, key rotates per lease refresh       |
| Shared protocol contracts    | Lease/meter/TSA validation + monotonic counter checks             |
| License server (hosted)      | Hono on Cloudflare Workers + D1                                   |
| License server (self-hosted) | Docker + SQLite. Mandatory v1 deliverable for air-gapped buyers.  |
| TSA safeguards               | Token-freshness warnings + manual time-attestation contract       |
| Vendor dashboard             | Deferred to post-LOI. v1 ships `skillpack license` CLI + REST API |
| Demo skill                   | One legal contract review skill. No healthcare build in v1.       |

Full design: `~/.gstack/projects/hcproduct-verticalAI/baoharryngo-master-design-20260418-233940.md`

---

## Out of scope for v1

- Vendor dashboard UI (CLI + REST API only)
- Healthcare demo skill build (outreach only)
- Multi-seat/per-node licensing (one license = one install)
- FedRAMP, SOC2 Type II, HIPAA BAA (buyer-side vendor requirement)
- Bytecode/native obfuscation (v2)
- Stripe/billing integration (audit signal only in v1)
- Public docs site
- Language-specific SDKs (Python/TS); CLI wraps MCPB
- Free hosted tier/multi-tenant license server
- Out-of-band CRL push polling (daily lease refresh carries CRL)
- D1 rearchitecture for high-volume ingest (revisit post-LOI)
- LLM eval gate (no skillpack-owned prompt content in v1)

---

## License

Open core. Runtime + CLI: open source (Apache 2.0 planned). Hosted license server + dashboard: source-available, commercial.

---

## Status / next step

Eng review is complete and week-1 foundations are implemented:

- `packages/crypto`: signing, lease token, meter-chain primitives + hardening tests
- `packages/protocol`: shared validation contracts for lease/meter/TSA flows
- `packages/license-server`: lease issue/verify endpoints + manual TSA attestation endpoint
- `packages/tsa`: token-freshness monitor + manual attestation contract

Next implementation lane:

- Wire CLI and runtime integration to license-server and protocol contracts
- Replace in-memory lease storage with persistent hosted/self-hosted adapters
- Complete incident-ready TSA outage handling (operator workflow + runbook)
