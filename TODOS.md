1. [x] Data-model core: normalize meter upload into accepted usage events with first-class commercial dimensions (`provider/customer/workspace/seat/skill/bundle/lease`).
2. [x] Contract model: enforce meter-upload and accepted-usage contracts in `@skillpack/protocol` using Zod and wire through license-server ingest.
3. [x] API/CLI: support commercial-context upload fields and dimension filters on `usage summary`.
4. [x] Control-plane management API: add provider/customer/workspace create endpoints with hierarchy enforcement and parity across memory + SQLite stores.
5. [x] Commercial core next: add pricing-rule contracts and a first invoice-line generation pass from accepted usage.
6. [x] Data-model next: persist `pricing_rules`, `invoices`, and invoice line JSON in memory, SQLite, and D1 stores; expose pricing-rule and invoice read APIs.
7. [ ] Dashboard API hardening after billing contracts are stable.
8. [ ] P2: `saveWorkspace` TOCTOU — add DB-level identity constraint (`CHECK` on `provider_id`/`customer_id` in ON CONFLICT clause) to both SQLite and D1 migrations so concurrent upserts with mismatched identity fail at the DB layer rather than only at the read-check-write app layer.
9. [x] Deploy lane next: add CI/CD for hosted `apps/api` and `apps/dashboard` so frontend and backend can deploy independently but stay env-wired together (`SKILLPACK_API_BASE_URL`, dashboard origin, Clerk config, management key injection).
10. [ ] Deploy verification: add post-deploy smoke coverage for the hosted pair (`/healthz`, `/app-config`, authenticated dashboard proxy call, provider/customer/workspace create, policy issue, meter upload, usage summary).
11. [ ] Docs truth-sync: reconcile `README.md`, `CLAUDE.md`, and runbooks with the current repo state so they consistently describe what already ships (dashboard worker exists, hosted API worker exists) vs. what is still pending.
12. [ ] Optional self-host path decision: either ship a real self-hosted `apps/api` deployable (Bun HTTP + SQLite + Docker) for air-gapped provider ops, or explicitly de-scope it from v1 docs if hosted-only is the intended product.
