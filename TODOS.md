1. [x] Data-model core: normalize meter upload into accepted usage events with first-class commercial dimensions (`provider/customer/workspace/seat/skill/bundle/lease`).
2. [x] Contract model: enforce meter-upload and accepted-usage contracts in `@skillpack/protocol` using Zod and wire through license-server ingest.
3. [x] API/CLI: support commercial-context upload fields and dimension filters on `usage summary`.
4. [x] Control-plane management API: add provider/customer/workspace create endpoints with hierarchy enforcement and parity across memory + SQLite stores.
5. [ ] Commercial core next: add pricing-rule contracts and a first invoice-line generation pass from accepted usage.
6. [ ] Data-model next: persist `pricing_rules`, `invoices`, and `invoice_lines` in SQLite store and expose read APIs.
7. [ ] Dashboard API hardening after billing contracts are stable.
8. [ ] P2: `saveWorkspace` TOCTOU — add DB-level identity constraint (`CHECK` on `provider_id`/`customer_id` in ON CONFLICT clause) to both SQLite and D1 migrations so concurrent upserts with mismatched identity fail at the DB layer rather than only at the read-check-write app layer.
