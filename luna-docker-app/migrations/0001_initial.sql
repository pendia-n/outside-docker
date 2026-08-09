PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  machine_only INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK(kind IN ('human','machine')),
  external_ref TEXT NOT NULL,
  chain_salt TEXT NOT NULL,
  head_proof TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  latest_checkpoint_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, kind, external_ref)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  chain_id TEXT NOT NULL REFERENCES chains(id),
  kind TEXT NOT NULL CHECK(kind IN ('human','machine')),
  idempotency_key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  encryption_nonce TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  proof TEXT NOT NULL UNIQUE,
  previous_proof TEXT,
  chain_position INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(chain_id, chain_position),
  UNIQUE(tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS anchor_batches (
  id TEXT PRIMARY KEY,
  merkle_root TEXT NOT NULL UNIQUE,
  leaf_count INTEGER NOT NULL,
  network TEXT NOT NULL,
  network_chain_id INTEGER NOT NULL,
  tx_hash TEXT,
  block_number INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending','submitted','confirmed','failed')),
  submitted_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_chains_tenant ON chains(tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_chain_position ON events(chain_id, chain_position);
CREATE INDEX IF NOT EXISTS idx_events_proof ON events(proof);
