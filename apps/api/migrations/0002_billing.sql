CREATE TABLE IF NOT EXISTS pricing_rules (
  pricing_rule_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  customer_id TEXT,
  workspace_id TEXT,
  skill_id TEXT,
  bundle_id TEXT,
  tool_name TEXT,
  unit TEXT NOT NULL,
  currency TEXT NOT NULL,
  unit_amount_cents INTEGER NOT NULL,
  included_units REAL NOT NULL,
  minimum_amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  payment_provider_json TEXT,
  updated_at_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  invoice_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  workspace_id TEXT,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  period_start_sec INTEGER NOT NULL,
  period_end_sec INTEGER NOT NULL,
  subtotal_amount_cents INTEGER NOT NULL,
  total_amount_cents INTEGER NOT NULL,
  invoice_json TEXT NOT NULL,
  updated_at_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_handoffs (
  invoice_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  checkout_url TEXT,
  external_id TEXT,
  handoff_json TEXT NOT NULL,
  updated_at_sec INTEGER NOT NULL
);
