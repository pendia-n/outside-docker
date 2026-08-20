PRAGMA foreign_keys = ON;

-- Phase 1 is intentionally additive. The original 0001 tables and columns remain
-- valid so deployed dev/prod databases can be upgraded without rebuilding data.

-- ---------------------------------------------------------------------------
-- Existing account and billing foundations
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN email_normalized TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN profile_organization TEXT;
ALTER TABLE users ADD COLUMN totp_required INTEGER NOT NULL DEFAULT 0
  CHECK (totp_required IN (0, 1));
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1
  CHECK (session_version >= 1);
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN disabled_at TEXT;
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;

-- Backfill only one row for each normalized address. Any legacy duplicate stays
-- NULL and can be resolved explicitly rather than making the migration fail.
UPDATE users AS candidate
SET email_normalized = lower(trim(candidate.email))
WHERE candidate.email IS NOT NULL
  AND trim(candidate.email) <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM users AS earlier
    WHERE earlier.id < candidate.id
      AND earlier.email IS NOT NULL
      AND lower(trim(earlier.email)) = lower(trim(candidate.email))
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized_unique
  ON users(email_normalized)
  WHERE email_normalized IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer_unique
  ON users(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_role_active
  ON users(role, is_active, disabled_at);

ALTER TABLE organizations ADD COLUMN initial_mode TEXT
  CHECK (initial_mode IN ('H', 'M', 'HM', 'both'));
ALTER TABLE organizations ADD COLUMN billing_email TEXT;
ALTER TABLE organizations ADD COLUMN updated_at TEXT;

UPDATE organizations
SET updated_at = created_at
WHERE updated_at IS NULL;

CREATE TABLE IF NOT EXISTS billing_plans (
  code TEXT PRIMARY KEY,
  audience TEXT NOT NULL CHECK (audience IN ('supplier', 'verifier')),
  name TEXT NOT NULL,
  write_rate_per_minute INTEGER NOT NULL DEFAULT 0 CHECK (write_rate_per_minute >= 0),
  records_per_write INTEGER NOT NULL DEFAULT 0 CHECK (records_per_write >= 0),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  access_days INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO billing_plans
  (code, audience, name, write_rate_per_minute, records_per_write, price_cents, access_days)
VALUES
  ('A', 'supplier', 'Supplier A', 2, 250, 9900, NULL),
  ('B', 'supplier', 'Supplier B', 4, 700, 29900, NULL),
  ('C', 'supplier', 'Supplier C', 10, 1150, 79900, NULL),
  ('D', 'supplier', 'Supplier D', 20, 2000, 199900, NULL),
  ('VERIFIER_30D', 'verifier', 'Verifier Read Pass', 0, 0, 2900, 30);

ALTER TABLE entitlements ADD COLUMN environment TEXT
  CHECK (environment IN ('dev', 'prod'));
ALTER TABLE entitlements ADD COLUMN plan_code TEXT
  REFERENCES billing_plans(code) ON DELETE RESTRICT;
ALTER TABLE entitlements ADD COLUMN billing_order_id TEXT
  REFERENCES billing_orders(id) ON DELETE RESTRICT;
ALTER TABLE entitlements ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE entitlements ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE entitlements ADD COLUMN stripe_checkout_session_id TEXT;
ALTER TABLE entitlements ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE entitlements ADD COLUMN stripe_price_id TEXT;
ALTER TABLE entitlements ADD COLUMN payment_status TEXT;
ALTER TABLE entitlements ADD COLUMN write_rate_per_minute INTEGER
  CHECK (write_rate_per_minute IS NULL OR write_rate_per_minute >= 0);
ALTER TABLE entitlements ADD COLUMN records_per_write INTEGER
  CHECK (records_per_write IS NULL OR records_per_write >= 0);
ALTER TABLE entitlements ADD COLUMN canceled_at TEXT;
ALTER TABLE entitlements ADD COLUMN updated_at TEXT;

UPDATE entitlements
SET updated_at = created_at
WHERE updated_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_stripe_subscription_unique
  ON entitlements(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_stripe_payment_unique
  ON entitlements(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_stripe_checkout_unique
  ON entitlements(stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entitlements_authorization
  ON entitlements(user_id, kind, status, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_entitlements_scope_authorization
  ON entitlements(scope_id, status, valid_from, valid_until);

ALTER TABLE api_keys ADD COLUMN key_prefix TEXT;
ALTER TABLE api_keys ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE api_keys ADD COLUMN environment TEXT
  CHECK (environment IN ('dev', 'prod'));
ALTER TABLE api_keys ADD COLUMN last_used_at TEXT;
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
ALTER TABLE api_keys ADD COLUMN revoked_at TEXT;
ALTER TABLE api_keys ADD COLUMN rotated_from_id TEXT
  REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE api_keys ADD COLUMN updated_at TEXT;

UPDATE api_keys
SET updated_at = created_at
WHERE updated_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_prefix_unique
  ON api_keys(key_prefix)
  WHERE key_prefix IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_owner_lifecycle
  ON api_keys(user_id, is_active, revoked_at, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_single_rotation
  ON api_keys(rotated_from_id)
  WHERE rotated_from_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_key_scopes (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN (
    'source:write',
    'record:write',
    'record:batch',
    'receipt:read',
    'usage:read'
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (api_key_id, scope)
);

-- ---------------------------------------------------------------------------
-- Authentication, verification, recovery, and revocable sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT,
  secret_key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  digits INTEGER NOT NULL DEFAULT 6 CHECK (digits BETWEEN 6 AND 8),
  period INTEGER NOT NULL DEFAULT 30 CHECK (period BETWEEN 15 AND 120),
  last_used_counter INTEGER,
  last_used_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_totp_recovery_unused
  ON totp_recovery_codes(user_id, used_at);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  pending_registration_id TEXT REFERENCES pending_registrations(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (user_id IS NOT NULL OR pending_registration_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_email_verification_pending
  ON email_verification_tokens(email_normalized, expires_at, used_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_password_reset_pending
  ON password_reset_tokens(user_id, expires_at, used_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
  ON auth_sessions(user_id, revoked_at, expires_at);

-- ---------------------------------------------------------------------------
-- Human cases, machine sources, and their logical chains
-- ---------------------------------------------------------------------------

ALTER TABLE chains ADD COLUMN head_event_id TEXT REFERENCES events(id) ON DELETE RESTRICT;
ALTER TABLE chains ADD COLUMN last_received_at TEXT;
ALTER TABLE chains ADD COLUMN is_closed INTEGER NOT NULL DEFAULT 0
  CHECK (is_closed IN (0, 1));
ALTER TABLE chains ADD COLUMN updated_at TEXT;

UPDATE chains
SET updated_at = created_at
WHERE updated_at IS NULL;

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  chain_id TEXT UNIQUE REFERENCES chains(id) ON DELETE RESTRICT,
  case_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  UNIQUE (owner_id, case_ref)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_org_ref_unique
  ON cases(organization_id, case_ref)
  WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cases_owner_status
  ON cases(owner_id, status, updated_at);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  chain_id TEXT UNIQUE REFERENCES chains(id) ON DELETE RESTRICT,
  external_ref TEXT NOT NULL,
  label TEXT NOT NULL,
  source_type TEXT,
  out_of_order_policy TEXT NOT NULL DEFAULT 'flag',
  last_sequence INTEGER,
  last_received_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked', 'archived')),
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, external_ref)
);

CREATE INDEX IF NOT EXISTS idx_sources_owner_status
  ON sources(owner_id, status, updated_at);

CREATE TABLE IF NOT EXISTS source_keys (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  external_key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_id, external_key_id),
  UNIQUE (source_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_source_keys_lifecycle
  ON source_keys(source_id, status, valid_from, valid_until);

-- ---------------------------------------------------------------------------
-- Published evidence scopes and production onboarding/billing
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evidence_scopes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('case', 'delivery', 'event_group', 'event', 'custom')),
  scope_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  case_id TEXT REFERENCES cases(id) ON DELETE RESTRICT,
  source_id TEXT REFERENCES sources(id) ON DELETE RESTRICT,
  delivery_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'revoked', 'archived')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, scope_type, scope_ref)
);

CREATE INDEX IF NOT EXISTS idx_evidence_scopes_publication
  ON evidence_scopes(owner_id, status, scope_type, published_at);
CREATE INDEX IF NOT EXISTS idx_evidence_scopes_case
  ON evidence_scopes(case_id, status)
  WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_scopes_delivery
  ON evidence_scopes(delivery_id, status)
  WHERE delivery_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pending_registrations (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('dev', 'prod')),
  role TEXT NOT NULL CHECK (role IN ('supplier', 'verifier')),
  username TEXT NOT NULL,
  email TEXT,
  email_normalized TEXT,
  email_verified_at TEXT,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  profile_organization TEXT,
  legal_name TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  country TEXT,
  initial_mode TEXT CHECK (initial_mode IN ('H', 'M', 'HM', 'both')),
  plan_code TEXT REFERENCES billing_plans(code) ON DELETE RESTRICT,
  verifier_scope_id TEXT REFERENCES evidence_scopes(id) ON DELETE RESTRICT,
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0, 1)),
  stripe_customer_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_subscription_id TEXT,
  activated_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'checkout_created', 'paid', 'completed', 'expired', 'cancelled', 'failed'
  )),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_username_open_unique
  ON pending_registrations(environment, username)
  WHERE status IN ('pending', 'checkout_created', 'paid');
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email_open_unique
  ON pending_registrations(environment, email_normalized)
  WHERE email_normalized IS NOT NULL
    AND status IN ('pending', 'checkout_created', 'paid');
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_checkout_unique
  ON pending_registrations(stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_payment_unique
  ON pending_registrations(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_subscription_unique
  ON pending_registrations(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_activated_user_unique
  ON pending_registrations(activated_user_id)
  WHERE activated_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pending_lifecycle
  ON pending_registrations(environment, status, expires_at);

CREATE TABLE IF NOT EXISTS billing_orders (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('dev', 'prod')),
  order_type TEXT NOT NULL CHECK (order_type IN ('supplier_subscription', 'verifier_read_pass')),
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  pending_registration_id TEXT REFERENCES pending_registrations(id) ON DELETE RESTRICT,
  scope_id TEXT REFERENCES evidence_scopes(id) ON DELETE RESTRICT,
  plan_code TEXT REFERENCES billing_plans(code) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'checkout_created', 'paid', 'fulfilled', 'failed', 'expired', 'refunded', 'cancelled'
  )),
  stripe_customer_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  entitlement_id TEXT REFERENCES entitlements(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK (user_id IS NOT NULL OR pending_registration_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_orders_checkout_unique
  ON billing_orders(stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_orders_payment_unique
  ON billing_orders(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_orders_user_status
  ON billing_orders(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_billing_orders_pending_status
  ON billing_orders(pending_registration_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_orders_entitlement_unique
  ON billing_orders(entitlement_id)
  WHERE entitlement_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('dev', 'prod')),
  event_type TEXT NOT NULL,
  object_id TEXT,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  api_version TEXT,
  payload_hash TEXT NOT NULL,
  billing_order_id TEXT REFERENCES billing_orders(id) ON DELETE RESTRICT,
  pending_registration_id TEXT REFERENCES pending_registrations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processing_started_at TEXT,
  processed_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_processing
  ON stripe_webhook_events(environment, status, received_at);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_object
  ON stripe_webhook_events(object_id, event_type)
  WHERE object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_order
  ON stripe_webhook_events(billing_order_id, status)
  WHERE billing_order_id IS NOT NULL;

-- Now that pending_registrations exists, connect pre-account verification rows.
CREATE INDEX IF NOT EXISTS idx_email_verification_registration
  ON email_verification_tokens(pending_registration_id, expires_at, used_at)
  WHERE pending_registration_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Receipt signing keys and Polygon/Merkle anchoring
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS receipt_signing_keys (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('dev', 'prod')),
  algorithm TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'revoked')),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  retired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_receipt_signing_keys_active
  ON receipt_signing_keys(environment, status, valid_from, valid_until);

CREATE TABLE IF NOT EXISTS anchor_batches (
  id TEXT PRIMARY KEY,
  environment TEXT CHECK (environment IN ('dev', 'prod')),
  batch_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'building', 'ready', 'submitted', 'confirmed', 'retry', 'failed'
  )),
  merkle_root TEXT,
  manifest_hash TEXT,
  leaf_count INTEGER NOT NULL DEFAULT 0 CHECK (leaf_count >= 0),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TEXT,
  last_error TEXT,
  tx_hash TEXT,
  block_number INTEGER,
  block_hash TEXT,
  chain_id TEXT NOT NULL,
  network TEXT,
  contract_address TEXT NOT NULL,
  contract_timestamp TEXT,
  submitted_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (environment, batch_ref)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_anchor_batches_tx_unique
  ON anchor_batches(chain_id, tx_hash)
  WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_anchor_batches_work_queue
  ON anchor_batches(environment, status, next_retry_at, created_at);

CREATE TABLE IF NOT EXISTS anchor_attempts (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES anchor_batches(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
  tx_hash TEXT,
  error_code TEXT,
  error_message TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (batch_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_anchor_attempts_batch
  ON anchor_attempts(batch_id, attempt_number);

-- ---------------------------------------------------------------------------
-- Expanded immutable event facts and current anchor state
-- ---------------------------------------------------------------------------

ALTER TABLE events ADD COLUMN track TEXT
  CHECK (track IS NULL OR track IN ('H', 'M'));
ALTER TABLE events ADD COLUMN external_ref TEXT;
ALTER TABLE events ADD COLUMN case_id TEXT REFERENCES cases(id) ON DELETE RESTRICT;
ALTER TABLE events ADD COLUMN event_type TEXT;
ALTER TABLE events ADD COLUMN action TEXT;
ALTER TABLE events ADD COLUMN source_id TEXT REFERENCES sources(id) ON DELETE RESTRICT;
ALTER TABLE events ADD COLUMN delivery_id TEXT;
ALTER TABLE events ADD COLUMN occurred_at TEXT;
ALTER TABLE events ADD COLUMN received_at TEXT;
ALTER TABLE events ADD COLUMN sequence INTEGER;
ALTER TABLE events ADD COLUMN idempotency_key TEXT;
ALTER TABLE events ADD COLUMN credential_type TEXT;
ALTER TABLE events ADD COLUMN credential_id TEXT;
ALTER TABLE events ADD COLUMN request_hash TEXT;
ALTER TABLE events ADD COLUMN source_key_id TEXT;
ALTER TABLE events ADD COLUMN source_signature TEXT;
ALTER TABLE events ADD COLUMN corrects_event_id TEXT REFERENCES events(id) ON DELETE RESTRICT;
ALTER TABLE events ADD COLUMN sequence_status TEXT;
ALTER TABLE events ADD COLUMN metadata_json TEXT;
ALTER TABLE events ADD COLUMN anchor_status TEXT NOT NULL DEFAULT 'pending_anchor'
  CHECK (anchor_status IN ('pending_anchor', 'anchoring', 'batching', 'submitted', 'anchored', 'anchor_failed'));
ALTER TABLE events ADD COLUMN anchor_batch_id TEXT REFERENCES anchor_batches(id) ON DELETE RESTRICT;
ALTER TABLE events ADD COLUMN updated_at TEXT;

UPDATE events
SET track = (SELECT chains.track FROM chains WHERE chains.id = events.chain_id),
    external_ref = (SELECT chains.external_ref FROM chains WHERE chains.id = events.chain_id),
    event_type = COALESCE(event_type, 'COMMITMENT_CAPTURED'),
    received_at = COALESCE(received_at, created_at),
    updated_at = COALESCE(updated_at, created_at)
WHERE track IS NULL
   OR external_ref IS NULL
   OR event_type IS NULL
   OR received_at IS NULL
   OR updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_events_owner_track_received
  ON events(owner_id, track, received_at, id);
CREATE INDEX IF NOT EXISTS idx_events_case_position
  ON events(case_id, position)
  WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_source_sequence
  ON events(source_id, sequence)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_delivery_received
  ON events(owner_id, delivery_id, received_at, id)
  WHERE delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_anchor_queue
  ON events(anchor_status, received_at, id);
CREATE INDEX IF NOT EXISTS idx_events_anchor_batch
  ON events(anchor_batch_id, position)
  WHERE anchor_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_correction
  ON events(corrects_event_id)
  WHERE corrects_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_credential_idempotency_unique
  ON events(credential_type, credential_id, idempotency_key)
  WHERE credential_type IS NOT NULL
    AND credential_id IS NOT NULL
    AND idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS idempotency_records (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  credential_type TEXT NOT NULL CHECK (credential_type IN ('session', 'api_key', 'webhook')),
  credential_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  response_status INTEGER,
  response_json TEXT,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  UNIQUE (credential_type, credential_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_owner_created
  ON idempotency_records(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry
  ON idempotency_records(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS anchor_batch_events (
  batch_id TEXT NOT NULL REFERENCES anchor_batches(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  leaf_index INTEGER NOT NULL CHECK (leaf_index >= 0),
  leaf_hash TEXT NOT NULL,
  merkle_proof_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (batch_id, event_id),
  UNIQUE (batch_id, leaf_index),
  UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS idx_anchor_batch_events_event
  ON anchor_batch_events(event_id, batch_id);

ALTER TABLE receipts ADD COLUMN receipt_version TEXT NOT NULL DEFAULT '1';
ALTER TABLE receipts ADD COLUMN signature_algorithm TEXT NOT NULL DEFAULT 'Ed25519';
ALTER TABLE receipts ADD COLUMN payload_hash TEXT;
ALTER TABLE receipts ADD COLUMN environment TEXT
  CHECK (environment IN ('dev', 'prod'));
ALTER TABLE receipts ADD COLUMN anchor_status TEXT NOT NULL DEFAULT 'pending_anchor'
  CHECK (anchor_status IN ('pending_anchor', 'anchoring', 'batching', 'submitted', 'anchored', 'anchor_failed'));
ALTER TABLE receipts ADD COLUMN issued_at TEXT;
ALTER TABLE receipts ADD COLUMN updated_at TEXT;

UPDATE receipts
SET signature_algorithm = CASE
      WHEN lower(signing_key_id) LIKE '%hs256%' THEN 'HS256'
      ELSE signature_algorithm
    END,
    issued_at = COALESCE(issued_at, created_at),
    updated_at = COALESCE(updated_at, created_at)
WHERE issued_at IS NULL OR updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_receipts_anchor_status
  ON receipts(anchor_status, created_at);
CREATE INDEX IF NOT EXISTS idx_receipts_signing_key
  ON receipts(signing_key_id, created_at);

CREATE TABLE IF NOT EXISTS receipt_versions (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  anchor_status TEXT NOT NULL CHECK (anchor_status IN (
    'pending_anchor', 'anchoring', 'batching', 'submitted', 'anchored', 'anchor_failed'
  )),
  receipt_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  signature_algorithm TEXT NOT NULL,
  signing_key_id TEXT NOT NULL REFERENCES receipt_signing_keys(id) ON DELETE RESTRICT,
  issued_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (receipt_id, version)
);

CREATE INDEX IF NOT EXISTS idx_receipt_versions_event
  ON receipt_versions(event_id, version);

-- ---------------------------------------------------------------------------
-- Scoped read access and deliberately shared free verification
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evidence_scope_members (
  scope_id TEXT NOT NULL REFERENCES evidence_scopes(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  position INTEGER CHECK (position IS NULL OR position > 0),
  added_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_id, event_id),
  UNIQUE (scope_id, position)
);

CREATE INDEX IF NOT EXISTS idx_scope_members_event
  ON evidence_scope_members(event_id, scope_id);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('case', 'delivery', 'event_group', 'event', 'custom')),
  scope_id TEXT NOT NULL REFERENCES evidence_scopes(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT,
  include_pdf INTEGER NOT NULL DEFAULT 0 CHECK (include_pdf IN (0, 1)),
  include_proof INTEGER NOT NULL DEFAULT 1 CHECK (include_proof IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  max_views INTEGER CHECK (max_views IS NULL OR max_views > 0),
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  expires_at TEXT,
  revoked_at TEXT,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shares_owner_lifecycle
  ON shares(owner_id, status, expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_shares_scope
  ON shares(scope_id, status, expires_at);

CREATE TABLE IF NOT EXISTS share_access_events (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'expired', 'revoked', 'invalid')),
  ip_hash TEXT,
  user_agent_hash TEXT,
  accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_share_access_events_share
  ON share_access_events(share_id, accessed_at);

-- ---------------------------------------------------------------------------
-- Durable usage accounting and short-window rate counters
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_counters (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  credential_type TEXT NOT NULL CHECK (credential_type IN ('session', 'api_key', 'system')),
  credential_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  bucket_seconds INTEGER NOT NULL CHECK (bucket_seconds > 0),
  value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, credential_type, credential_id, metric, bucket_start, bucket_seconds)
);

CREATE INDEX IF NOT EXISTS idx_usage_counters_lookup
  ON usage_counters(owner_id, metric, bucket_start);

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  owner_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  credential_type TEXT NOT NULL CHECK (credential_type IN ('session', 'api_key', 'share', 'ip')),
  credential_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (credential_type, credential_id, route_key, window_start, window_seconds)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_cleanup
  ON rate_limit_counters(window_start, window_seconds);

-- New evidence rows deliberately use RESTRICT/SET NULL rather than CASCADE.
-- These guards also stop legacy 0001 cascades from erasing an established chain
-- or event if an account-deletion path is introduced later.
CREATE TRIGGER IF NOT EXISTS protect_user_evidence_before_delete
BEFORE DELETE ON users
WHEN EXISTS (SELECT 1 FROM chains WHERE owner_id = OLD.id)
  OR EXISTS (SELECT 1 FROM cases WHERE owner_id = OLD.id)
  OR EXISTS (SELECT 1 FROM sources WHERE owner_id = OLD.id)
  OR EXISTS (SELECT 1 FROM evidence_scopes WHERE owner_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'evidence owners must be deactivated, not deleted');
END;

CREATE TRIGGER IF NOT EXISTS protect_chain_events_before_delete
BEFORE DELETE ON chains
WHEN EXISTS (SELECT 1 FROM events WHERE chain_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'evidence chains with events cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS protect_event_before_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'evidence events are append-only and cannot be deleted');
END;

-- Cryptographic facts are immutable after append. Anchoring is deliberately
-- represented by the small mutable status/batch projection on the event and
-- receipt; the original signed receipt bytes never change.
CREATE TRIGGER IF NOT EXISTS protect_event_facts_before_update
BEFORE UPDATE ON events
WHEN NEW.id IS NOT OLD.id
  OR NEW.chain_id IS NOT OLD.chain_id
  OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.position IS NOT OLD.position
  OR NEW.commitment IS NOT OLD.commitment
  OR NEW.manifest_hash IS NOT OLD.manifest_hash
  OR NEW.encrypted_capsule IS NOT OLD.encrypted_capsule
  OR NEW.previous_proof IS NOT OLD.previous_proof
  OR NEW.proof IS NOT OLD.proof
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.track IS NOT OLD.track
  OR NEW.external_ref IS NOT OLD.external_ref
  OR NEW.case_id IS NOT OLD.case_id
  OR NEW.event_type IS NOT OLD.event_type
  OR NEW.action IS NOT OLD.action
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.delivery_id IS NOT OLD.delivery_id
  OR NEW.occurred_at IS NOT OLD.occurred_at
  OR NEW.received_at IS NOT OLD.received_at
  OR NEW.sequence IS NOT OLD.sequence
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.credential_type IS NOT OLD.credential_type
  OR NEW.credential_id IS NOT OLD.credential_id
  OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.source_key_id IS NOT OLD.source_key_id
  OR NEW.source_signature IS NOT OLD.source_signature
  OR NEW.corrects_event_id IS NOT OLD.corrects_event_id
  OR NEW.sequence_status IS NOT OLD.sequence_status
  OR NEW.metadata_json IS NOT OLD.metadata_json
BEGIN
  SELECT RAISE(ABORT, 'evidence event facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protect_receipt_facts_before_update
BEFORE UPDATE ON receipts
WHEN NEW.id IS NOT OLD.id
  OR NEW.event_id IS NOT OLD.event_id
  OR NEW.receipt_json IS NOT OLD.receipt_json
  OR NEW.signature IS NOT OLD.signature
  OR NEW.signing_key_id IS NOT OLD.signing_key_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.receipt_version IS NOT OLD.receipt_version
  OR NEW.signature_algorithm IS NOT OLD.signature_algorithm
  OR NEW.payload_hash IS NOT OLD.payload_hash
  OR NEW.environment IS NOT OLD.environment
  OR NEW.issued_at IS NOT OLD.issued_at
BEGIN
  SELECT RAISE(ABORT, 'signed receipt facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protect_event_anchor_binding_before_update
BEFORE UPDATE ON events
WHEN OLD.anchor_batch_id IS NOT NULL AND NEW.anchor_batch_id IS NOT OLD.anchor_batch_id
BEGIN
  SELECT RAISE(ABORT, 'an event anchor batch cannot be replaced or cleared');
END;

CREATE TRIGGER IF NOT EXISTS protect_receipt_before_delete
BEFORE DELETE ON receipts
BEGIN
  SELECT RAISE(ABORT, 'signed receipts cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS protect_receipt_version_before_delete
BEFORE DELETE ON receipt_versions
BEGIN
  SELECT RAISE(ABORT, 'signed receipt versions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS protect_receipt_version_before_update
BEFORE UPDATE ON receipt_versions
BEGIN
  SELECT RAISE(ABORT, 'signed receipt versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protect_anchor_membership_before_delete
BEFORE DELETE ON anchor_batch_events
BEGIN
  SELECT RAISE(ABORT, 'anchor membership cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS protect_anchor_membership_before_update
BEFORE UPDATE ON anchor_batch_events
BEGIN
  SELECT RAISE(ABORT, 'anchor membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protect_chain_identity_before_update
BEFORE UPDATE ON chains
WHEN NEW.id IS NOT OLD.id
  OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.track IS NOT OLD.track
  OR NEW.external_ref IS NOT OLD.external_ref
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'evidence chain identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protect_closed_chain_before_update
BEFORE UPDATE ON chains
WHEN OLD.is_closed = 1 AND NEW.is_closed <> 1
BEGIN
  SELECT RAISE(ABORT, 'a closed evidence chain cannot be reopened');
END;

CREATE TRIGGER IF NOT EXISTS protect_anchor_batch_facts_before_update
BEFORE UPDATE ON anchor_batches
WHEN NEW.id IS NOT OLD.id
  OR NEW.environment IS NOT OLD.environment
  OR NEW.batch_ref IS NOT OLD.batch_ref
  OR NEW.merkle_root IS NOT OLD.merkle_root
  OR NEW.manifest_hash IS NOT OLD.manifest_hash
  OR NEW.leaf_count IS NOT OLD.leaf_count
  OR NEW.event_count IS NOT OLD.event_count
  OR NEW.chain_id IS NOT OLD.chain_id
  OR NEW.network IS NOT OLD.network
  OR NEW.contract_address IS NOT OLD.contract_address
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'anchor batch facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protect_published_scope_members_before_insert
BEFORE INSERT ON evidence_scope_members
WHEN COALESCE((SELECT status FROM evidence_scopes WHERE id = NEW.scope_id), '') <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'published scope membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protect_published_scope_members_before_update
BEFORE UPDATE ON evidence_scope_members
WHEN COALESCE((SELECT status FROM evidence_scopes WHERE id = OLD.scope_id), '') <> 'draft'
  OR COALESCE((SELECT status FROM evidence_scopes WHERE id = NEW.scope_id), '') <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'published scope membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protect_published_scope_members_before_delete
BEFORE DELETE ON evidence_scope_members
WHEN COALESCE((SELECT status FROM evidence_scopes WHERE id = OLD.scope_id), '') <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'published scope membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protect_scope_from_reopening
BEFORE UPDATE ON evidence_scopes
WHEN OLD.status <> 'draft' AND NEW.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'a published or retired scope cannot return to draft');
END;

CREATE TRIGGER IF NOT EXISTS protect_published_scope_facts
BEFORE UPDATE ON evidence_scopes
WHEN OLD.status <> 'draft' AND (
  NEW.id IS NOT OLD.id
  OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.scope_type IS NOT OLD.scope_type
  OR NEW.scope_ref IS NOT OLD.scope_ref
  OR NEW.title IS NOT OLD.title
  OR NEW.summary IS NOT OLD.summary
  OR NEW.case_id IS NOT OLD.case_id
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.delivery_id IS NOT OLD.delivery_id
  OR NEW.published_at IS NOT OLD.published_at
  OR NEW.created_at IS NOT OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'published scope facts are immutable');
END;
