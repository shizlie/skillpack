# skillpack

Commerce layer for vertical AI skills shipped as compiled `.mcpb` bundles.

**Status:** pre-product. Design approved 2026-04-18. Week-1 foundations and CLI/runtime integration shipped (crypto, protocol, license-server, TSA contracts, CLI/runtime packages).

**From the initiator:** Please don't use this if not needed. Skills and knowledges should be shared in the open whenever possible, for the common good. I created this just to help moving scene forward, Skill As A Software (SaaS, SkAAS, or whatever you want to call it)

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

| Layer                        | Stack                                                             |
| ---------------------------- | ----------------------------------------------------------------- |
| Vendor CLI                   | Bun + TypeScript                                                  |
| Embedded runtime             | Node + `better-sqlite3` (Claude Desktop hosts MCPB via Node)      |
| Signing                      | Ed25519 via `@noble/ed25519`                                      |
| Licensing                    | Lease-based: 30d TTL, 72h grace. Not instant revoke.              |
| Metering                     | HMAC-chained append-only log, key rotates per lease refresh       |
| Shared protocol contracts    | Lease/meter/TSA validation + monotonic counter checks             |
| License server (hosted)      | Hono on Cloudflare Workers + D1                                   |
| License server (self-hosted) | Docker + SQLite. Mandatory v1 deliverable for air-gapped buyers.  |
| TSA safeguards               | Token-freshness warnings + manual time-attestation contract       |
| Vendor dashboard             | Cloudflare Worker dashboard with Clerk auth + server-side API proxy |
| Demo skill                   | One legal contract review skill. No healthcare build in v1.       |

Full design: `~/.gstack/projects/hcproduct-verticalAI/baoharryngo-master-design-20260418-233940.md`

---

## Out of scope for v1

- Accounting-grade invoice lifecycle, tax, refunds, and reconciliation
- Healthcare demo skill build (outreach only)
- Multi-seat/per-node licensing (one license = one install)
- FedRAMP, SOC2 Type II, HIPAA BAA (buyer-side vendor requirement)
- Bytecode/native obfuscation (v2)
- Payment webhooks and automatic invoice status reconciliation
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

## Documentation map

- `README.md`: product overview and current implementation status
- `CHANGELOG.md`: shipped release history
- `TODOS.md`: remaining implementation backlog
- `CLAUDE.md`: contributor/project operating guide
- `NOTES.md`: research notes and thesis context
- `TEST_PLAN.md`: AI-first unit + E2E test strategy and execution policy
- `docs/runbooks/cloudflare-d1-deploy.md`: Cloudflare Worker + D1 deployment and `.mcpb` usage backhaul verification

## Test execution

- Unit/contract tests: `bun run test:unit`
- Cross-package E2E journey tests: `bun run test:e2e`
- Full local test run: `bun run test:unit && bun run test:e2e`

---

## Status / next step

Eng review is complete. Week-1 foundations and CLI/runtime integration are implemented:

- `packages/crypto`: signing, lease token, meter-chain primitives + hardening tests
- `packages/protocol`: shared validation contracts for lease/meter/TSA flows
- `packages/license-server`: lease issue/verify endpoints + manual TSA attestation endpoint
- `packages/tsa`: token-freshness monitor + manual attestation contract
- `packages/cli`: `skillpack` CLI commands for lease issue/verify + manual TSA attestation
- `packages/runtime`: runtime lease verification/grace handling + meter event emission

Next implementation lane:

- Validate the new release artifacts with a receiver smoke test on each tagged release and document expected operator troubleshooting paths.

## End-user install guide (Release artifacts)

Every GitHub tag release (`vX.Y.Z`) publishes operator-ready artifacts for users who do not want to clone/build the full repo.

Artifacts:

- `skillpack-cli-<version>-linux-x64` (standalone CLI binary)
- `skillpack-runtime-<version>-linux-x64` (standalone runtime server binary)
- `skillpack-cli-<version>-source.tar.gz` (auditable/rebuildable CLI workspace source bundle)
- `skillpack-runtime-<version>-source.tar.gz` (runtime source bundle)
- `*.sha256` checksum files for each artifact

### Option A: use standalone binaries (recommended for operators)

1. Download `skillpack-cli-<version>-linux-x64` and `skillpack-cli-<version>-linux-x64.sha256` from the release.
2. Verify integrity:

```bash
sha256sum -c skillpack-cli-<version>-linux-x64.sha256
```

3. Make executable and run:

```bash
chmod +x skillpack-cli-<version>-linux-x64
./skillpack-cli-<version>-linux-x64 --help
```

4. Do the same for runtime server binary:

```bash
sha256sum -c skillpack-runtime-<version>-linux-x64.sha256
chmod +x skillpack-runtime-<version>-linux-x64
./skillpack-runtime-<version>-linux-x64 <bundle.mcpb> <bundle.public.pem>
```

Runtime prerequisites on receiver machine:

- `node` is not required when using the compiled runtime binary.
- `unzip` and `tar` must be installed (runtime uses both to verify and unpack bundle assets).

### Option B: use source bundles (auditable/rebuildable)

CLI source bundle:

```bash
tar -xzf skillpack-cli-<version>-source.tar.gz
cd skillpack-cli-<version>
bun install --frozen-lockfile
bun apps/cli/src/cli.js --help
```

Runtime source bundle:

```bash
tar -xzf skillpack-runtime-<version>-source.tar.gz
node skillpack-runtime-<version>/server.mjs <bundle.mcpb> <bundle.public.pem>
```

## Policy loop demo (implemented)

CLI control commands now include:

- `skillpack policy issue`
- `skillpack policy sync`
- `skillpack meter upload`
- `skillpack usage summary`

Warning-only degradation is enforced at 100%-120% usage (`ALLOW_WITH_WARNING`), then hard stop beyond 120% (`DENY`).

Run the deterministic local value-loop demo:

```bash
./scripts/demo-policy-loop.sh
```

Runbook: `docs/runbooks/policy-loop-demo.md`

## Cloudflare Worker + D1 deploy (implemented)

Hosted control plane deployables now live in `apps/api` and `apps/dashboard`.
Their public wiring is resolved from `deploy/hosted-control-plane.manifest.json`.

Quick path:

1. Validate locally first:

```bash
./scripts/demo-cloudflare-local-e2e.sh
```

2. Configure D1, public origins, Clerk secrets, signing keys, and optional `SKILLPACK_API_KEY` for the hosted pair
3. Deploy the hosted control plane from a terminal with `bunx wrangler login` and `scripts/deploy/deploy-hosted-control-plane.mjs`
4. Run deployed smoke with either the Skillpack shared key or a Clerk bearer token:

```bash
bun scripts/deploy/smoke-hosted-control-plane.mjs \
  --api-base-url="https://<api-worker>.workers.dev" \
  --dashboard-base-url="https://<dashboard-worker>.workers.dev" \
  --api-key="<SKILLPACK_API_KEY>"
```

For Clerk-only API verification, replace `--api-key` with
`--api-auth-header="Bearer <short-lived Clerk session token>"`.

Continuous meter sync helper:

```bash
./scripts/sync-meter-loop.sh
```

Full runbook: `docs/runbooks/cloudflare-d1-deploy.md`

Direct-mode hosted verification is now supported:

- the bundle runtime still writes local `meter.jsonl`
- when `SKILLPACK_SYNC_MODE=direct` and `SKILLPACK_CONTROL_PLANE_URL` are set, the bundle-local meter client uploads usage directly to `/v1/meter/upload`
- the server derives accepted usage identity from the signed lease context, not from client-supplied commercial IDs

## Billing core (implemented)

Billing is owned by skillpack, payment collection is pluggable.

Core billing now supports:

- `POST /v1/billing/pricing-rules`
- `GET /v1/billing/pricing-rules`
- `POST /v1/billing/invoices/draft`
- `GET /v1/billing/invoices`
- `POST /v1/billing/invoices/:invoiceId/payment-handoff`

The hosted dashboard exposes pricing-rule creation, invoice drafting, invoice listing, and
manual/Dodo/Stripe payment handoff creation through the authenticated worker proxy. The CLI
exposes the same first path for self-hosted and open-source operators:

```bash
skillpack billing pricing-rule create \
  --server-url "$API_BASE_URL" --api-key "$API_KEY" \
  --pricing-rule-id price-search \
  --provider-id prov-1 --customer-id cust-1 \
  --tool wiki_search --currency USD --unit-amount-cents 25

skillpack billing invoice draft \
  --server-url "$API_BASE_URL" --api-key "$API_KEY" \
  --invoice-id inv-1 \
  --provider-id prov-1 --customer-id cust-1 \
  --period-start-sec 1800000000 \
  --period-end-sec 1802592000
```

Payment adapters are handoff-only. `manual` is always available; Dodo Payments can be enabled with `DODO_PAYMENTS_API_KEY`; Stripe has a compatible adapter for hosted Checkout sessions using price IDs. The accepted usage ledger and invoice records stay inside skillpack so vendors can collect money themselves or swap payment providers later.

## Policy loop demo (implemented)

CLI control commands now include:

- `skillpack policy issue`
- `skillpack policy sync`
- `skillpack meter upload`
- `skillpack usage summary`

Warning-only degradation is enforced at 100%-120% usage (`ALLOW_WITH_WARNING`), then hard stop beyond 120% (`DENY`).

Run the deterministic local value-loop demo:

```bash
./scripts/demo-policy-loop.sh
```

Runbook: `docs/runbooks/policy-loop-demo.md`

## Bundle packaging (`.mcpb`) (implemented)

`skillpack` now includes a bundle packaging command:

`skillpack bundle build --input-dir <skill-dir> --bundle-id <id> --version <semver> --output-file <path>.mcpb [--private-key-file <pem>] [--license-file <json>]`

Output bundle contents:

- `skill/...` (copied skill files)
- `manifest.json` (bundle metadata + file hashes)
- `manifest.sha256`
- `signature.bin` (if `--private-key-file` is provided)
- `license.json` (if `--license-file` is provided)

Preconfigured vertical bundle command (laws consultant):

`bun run bundle:laws-consultant`

This command:

- treats `verticals/laws-consultant/` as the Agent Skill root (`SKILL.md` at top-level)
- stages a safe bundle source (`SKILL.md` + archived `knowledge/wiki.tar.gz`) to avoid shipping plain wiki markdown files
- embeds `verticals/laws-consultant/distribution/license.dev.json` when present, otherwise uses a generated dev payload
- signs with a local dev key at `verticals/laws-consultant/distribution/keys/dev-private.pem` (auto-generated if missing)
- outputs:
    - `.mcpb` to `dist/skills/`
    - single release folder: `dist/skills/laws-consultant-<version>/`
    - single transfer archive: `dist/skills/laws-consultant-<version>-bundle.tar.gz`

Release folder includes:

- `laws-consultant-<version>.mcpb`
- `laws-consultant-<version>.public.pem`
- `SHA256SUMS`
- `runtime/verify-bundle.mjs`
- `runtime/install-skill.sh`
- `VERIFY.md`
- `skill/laws-consultant/` (ready-to-copy folder for Claude Code skills; only `SKILL.md`)

Important:

- Claude Code skills are folder-based (`~/.claude/skills/<name>/SKILL.md`).
- `.mcpb` is for MCP Bundle workflows. Keep both distribution paths.
- The `.mcpb` payload packages knowledge as an archived asset (`knowledge/wiki.tar.gz`) instead of plain wiki markdown files.

Verify on receiver machine (inside extracted `laws-consultant-<version>/`):

`shasum -a 256 -c SHA256SUMS`

`node runtime/verify-bundle.mjs laws-consultant-<version>.mcpb laws-consultant-<version>.public.pem`

## Wiki via MCP (implemented)

`@skillpack/wiki-mcp` exposes the local vertical wiki as MCP tools/resources.

- Package: `packages/wiki-mcp`
- Default wiki path: `verticals/laws-consultant/wiki`
- CLI binary: `skillpack-wiki-mcp`

Supported MCP methods:

- `initialize`
- `tools/list`
- `tools/call` (`wiki_search`, `wiki_read_page`)
- `resources/list`
- `resources/read` (`wiki://index`, `wiki://page/<slug>`)

Run locally:

`bun run packages/wiki-mcp/src/cli.js --wiki-dir=verticals/laws-consultant/wiki`

## TSA outage incident workflow (implemented)

For air-gapped customers where TSA freshness passes max age and no sneakernet token is available:

1. `skillpack license issue` surfaces TSA warning/expired state on stderr while keeping lease JSON on stdout.
2. Operator submits a ticket-scoped manual attestation to the license server:
   `skillpack tsa manual-attest --server-url <url> --customer-id <id> --seat-id <id> --operator-id <id> --ticket-id <id> --reason "<incident note>" --attested-at-sec <unix-sec>`
3. The next server-backed lease issue call with the same ticket embeds `tsaState.latestManualAttestation`:
   `skillpack license issue --server-url <url> --api-key <key> --customer-id <id> --seat-id <id> --last-tsa-token-at-sec <unix-sec> --tsa-ticket-id <ticketId>`
4. Runtime calls `buildTsaPolicyFromLeaseResponse(response)` and enforces the ticket-scoped attestation when TSA freshness is expired.
5. Operator can retrieve the latest stored attestation for a customer/seat/ticket:
   `skillpack tsa latest-attestation --server-url <url> --customer-id <id> --seat-id <id> --ticket-id <id>`

The default manual attestation validity window is 4 hours. Structured incident timeline export is deferred until a design partner specifies the audit format.

Storage integration:

- `@skillpack/license-server` now supports `createSqliteLeaseStore({ dbPath })` for persistent lease counters + manual attestation records.
- `startLicenseServer({ storageMode: "sqlite", storagePath: "/path/to/lease-store.sqlite" })` enables persistent self-hosted storage.
