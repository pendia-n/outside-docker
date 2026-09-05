PRAGMA foreign_keys = ON;

-- Role remains exclusive on users. Organizations may contain only members of
-- the same role; the Worker enforces that cross-table invariant on writes.
ALTER TABLE organizations ADD COLUMN organization_kind TEXT NOT NULL DEFAULT 'supplier'
  CHECK (organization_kind IN ('supplier', 'verifier'));

UPDATE organizations
SET organization_kind = COALESCE((SELECT role FROM users WHERE users.id = organizations.user_id), 'supplier');

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  member_role TEXT NOT NULL CHECK (member_role IN ('owner', 'admin', 'member', 'auditor')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  joined_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, user_id)
);

INSERT OR IGNORE INTO organization_memberships (
  organization_id, user_id, member_role, status, joined_at, created_at, updated_at
)
SELECT id, user_id, 'owner', 'active', created_at, created_at, COALESCE(updated_at, created_at)
FROM organizations;

CREATE INDEX IF NOT EXISTS idx_organization_memberships_user
  ON organization_memberships(user_id, status, organization_id);

CREATE TABLE IF NOT EXISTS supplier_event_types (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  event_type_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, event_type_ref)
);

CREATE TABLE IF NOT EXISTS event_instances (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type_id TEXT NOT NULL REFERENCES supplier_event_types(id) ON DELETE RESTRICT,
  instance_ref TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled', 'archived')),
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, event_type_id, instance_ref)
);

ALTER TABLE events ADD COLUMN event_type_id TEXT REFERENCES supplier_event_types(id) ON DELETE RESTRICT;
ALTER TABLE events ADD COLUMN event_instance_id TEXT REFERENCES event_instances(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_events_type_time
  ON events(owner_id, event_type_id, occurred_at, received_at, id)
  WHERE event_type_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_instance_position
  ON events(event_instance_id, position)
  WHERE event_instance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS verifier_invitations (
  id TEXT PRIMARY KEY,
  supplier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  supplier_organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  verifier_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  verifier_organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  event_type_id TEXT NOT NULL REFERENCES supplier_event_types(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_verifier_invitations_recipient
  ON verifier_invitations(verifier_user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_verifier_invitations_supplier
  ON verifier_invitations(supplier_user_id, event_type_id, status);

CREATE TABLE IF NOT EXISTS access_offers (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES verifier_invitations(id) ON DELETE RESTRICT,
  supplier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type_id TEXT NOT NULL REFERENCES supplier_event_types(id) ON DELETE RESTRICT,
  access_model TEXT NOT NULL CHECK (access_model IN ('one_time_range', 'subscription_28d')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS access_orders (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('dev', 'prod')),
  verifier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  offer_id TEXT NOT NULL REFERENCES access_offers(id) ON DELETE RESTRICT,
  event_type_id TEXT NOT NULL REFERENCES supplier_event_types(id) ON DELETE RESTRICT,
  access_model TEXT NOT NULL CHECK (access_model IN ('one_time_range', 'subscription_28d')),
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  seven_day_units INTEGER CHECK (seven_day_units IS NULL OR seven_day_units > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  pricing_version TEXT NOT NULL DEFAULT 'outdock-2026-09',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'checkout_created', 'paid', 'fulfilled', 'failed', 'expired', 'refunded', 'cancelled')),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK (range_start < range_end),
  CHECK (
    (access_model = 'one_time_range' AND seven_day_units IS NOT NULL)
    OR (access_model = 'subscription_28d' AND seven_day_units IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_access_orders_verifier
  ON access_orders(verifier_user_id, status, created_at);

CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY,
  access_order_id TEXT NOT NULL UNIQUE REFERENCES access_orders(id) ON DELETE RESTRICT,
  verifier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verifier_organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  supplier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type_id TEXT NOT NULL REFERENCES supplier_event_types(id) ON DELETE RESTRICT,
  access_model TEXT NOT NULL CHECK (access_model IN ('one_time_range', 'subscription_28d')),
  data_from TEXT NOT NULL,
  data_until TEXT NOT NULL,
  access_from TEXT NOT NULL,
  access_until TEXT NOT NULL,
  include_future_until TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'refunded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (data_from < data_until),
  CHECK (access_from < access_until)
);

CREATE INDEX IF NOT EXISTS idx_access_grants_active
  ON access_grants(verifier_user_id, status, access_until, event_type_id);

-- Only encrypted disclosure material is retained. The original content and the
-- plaintext data key are forbidden by application validation.
CREATE TABLE IF NOT EXISTS disclosure_capsules (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  format_version INTEGER NOT NULL DEFAULT 1 CHECK (format_version = 1),
  algorithm TEXT NOT NULL DEFAULT 'AES-GCM' CHECK (algorithm = 'AES-GCM'),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  aad_hash TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS disclosure_key_envelopes (
  id TEXT PRIMARY KEY,
  capsule_id TEXT NOT NULL REFERENCES disclosure_capsules(id) ON DELETE RESTRICT,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('supplier', 'access_grant')),
  grantee_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  key_id TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (capsule_id, grantee_type, grantee_id)
);

CREATE TABLE IF NOT EXISTS evidence_view_sessions (
  id TEXT PRIMARY KEY,
  access_grant_id TEXT NOT NULL REFERENCES access_grants(id) ON DELETE RESTRICT,
  verifier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  watermark_ref TEXT NOT NULL,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (started_at < expires_at)
);

CREATE TABLE IF NOT EXISTS evidence_access_logs (
  id TEXT PRIMARY KEY,
  access_grant_id TEXT NOT NULL REFERENCES access_grants(id) ON DELETE RESTRICT,
  view_session_id TEXT REFERENCES evidence_view_sessions(id) ON DELETE RESTRICT,
  verifier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('list', 'view', 'compare', 'capsule_unwrap', 'legal_export')),
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
  ip_hash TEXT,
  user_agent_hash TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evidence_access_logs_grant
  ON evidence_access_logs(access_grant_id, occurred_at);

CREATE TABLE IF NOT EXISTS priority_anchor_requests (
  id TEXT PRIMARY KEY,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  supplier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type_id TEXT REFERENCES supplier_event_types(id) ON DELETE RESTRICT,
  event_type_ref TEXT NOT NULL,
  access_order_id TEXT REFERENCES access_orders(id) ON DELETE RESTRICT,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'batching', 'completed', 'failed', 'cancelled')),
  anchor_batch_id TEXT REFERENCES anchor_batches(id) ON DELETE RESTRICT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK (range_start < range_end)
);

CREATE INDEX IF NOT EXISTS idx_priority_anchor_queue
  ON priority_anchor_requests(status, created_at);
