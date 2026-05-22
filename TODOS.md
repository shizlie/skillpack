1. [x] Data-model core: normalize meter upload into accepted usage events with first-class commercial dimensions (`provider/customer/workspace/seat/skill/bundle/lease`).
2. [x] Contract model: enforce meter-upload and accepted-usage contracts in `@skillpack/protocol` using Zod and wire through license-server ingest.
3. [x] API/CLI: support commercial-context upload fields and dimension filters on `usage summary`.
4. [x] Control-plane management API: add provider/customer/workspace create endpoints with hierarchy enforcement and parity across memory + SQLite stores.
5. [x] Commercial core next: add pricing-rule contracts and a first invoice-line generation pass from accepted usage.
6. [x] Data-model next: persist `pricing_rules`, `invoices`, and invoice line JSON in memory, SQLite, and D1 stores; expose pricing-rule and invoice read APIs.
7. [x] Dashboard billing cockpit: expose pricing-rule creation, invoice drafting/listing, and manual/Dodo/Stripe handoffs through the hosted dashboard proxy.
8. [x] Dashboard API hardening after billing contracts are stable: dashboard proxy now supports Clerk bearer-token forwarding to the API, while self-hosted/shared-key deployments keep `SKILLPACK_API_KEY`.
9. [x] P2: `saveWorkspace` TOCTOU — add DB-level identity constraint (`CHECK` on `provider_id`/`customer_id` in ON CONFLICT clause) to both SQLite and D1 migrations so concurrent upserts with mismatched identity fail at the DB layer rather than only at the read-check-write app layer.
10. [x] Deploy lane next: add terminal-first Wrangler deploy flow for hosted `apps/api` and `apps/dashboard` so frontend and backend deploy independently but stay env-wired together (`SKILLPACK_API_BASE_URL`, dashboard origin, Clerk config, management key injection).
11. [x] Deploy verification: add post-deploy smoke coverage for the hosted pair (`/healthz`, `/app-config`, authenticated dashboard proxy call, provider/customer/workspace create, policy issue, meter upload, usage summary, billing invoice draft).
12. [x] Docs truth-sync: reconcile `README.md`, `CLAUDE.md`, `PRODUCT.md`, and runbooks with the current repo state so they consistently describe what already ships vs. what is still pending.
13. [x] Self-host path decision: either ship a real self-hosted `apps/api` deployable (Bun HTTP + SQLite + Docker) for air-gapped provider ops, or explicitly de-scope it from v1 docs if hosted-only is the intended product. (Done — see `apps/self-hosted/`)
14. [ ] Analytics plane: usage ledger query/summarization surface for ops, finance, and customer success.
15. [ ] Dashboard crypto wiring: wire `@skillpack/crypto` verify/decode into dashboard UI for lease/policy integrity inspection from the browser.