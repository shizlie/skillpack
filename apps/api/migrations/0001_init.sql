CREATE TABLE IF NOT EXISTS lease_counters (
  customer_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  lease_counter INTEGER NOT NULL,
  PRIMARY KEY (customer_id, seat_id)
);

CREATE TABLE IF NOT EXISTS manual_attestations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  attested_at_sec INTEGER NOT NULL,
  recorded_at_sec INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_snapshots (
  workspace_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  updated_at_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  provider_id TEXT PRIMARY KEY,
  name TEXT,
  updated_at_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  provider_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT,
  updated_at_sec INTEGER NOT NULL,
  PRIMARY KEY (provider_id, customer_id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL,
  updated_at_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accepted_usage_events (
  event_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  skill_id TEXT,
  bundle_id TEXT,
  lease_id TEXT,
  lease_jti TEXT,
  policy_id TEXT,
  tool_name TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  usage_unit TEXT NOT NULL,
  usage_delta REAL NOT NULL,
  event_seq INTEGER NOT NULL,
  event_hash TEXT,
  prev_hash TEXT NOT NULL,
  event_at_sec INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE (workspace_id, seat_id, lease_jti, event_seq)
);
