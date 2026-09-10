# D1 schema and persistence model

The schema is cumulative across `0001_init.sql`, `0002_phase1.sql`, and `0003_outdock_access.sql`. Both `DB_DEV` and `DB_PROD` use the same migrations. Timestamps are stored as text, generally ISO-8601 from the Worker; original SQLite defaults use `datetime('now')` for fallback rows.

## Identity and organization

### `users`

Primary account row: username, optional email and normalized email, password hash, `supplier|verifier` role, TOTP flags, session version, active/disabled state, Stripe customer ID, login and audit timestamps. Unique indexes protect normalized email and Stripe customer ID when present.

### `organizations`

One legacy organization per owning user (`user_id` remains unique): legal/address fields, initial Supplier mode, billing email, `organization_kind` (`supplier|verifier`), timestamps. Registration creates an organization even for a Verifier, using username/default empty address values where fields are absent.

### `organization_memberships`

Many-to-many-ready organization membership with composite primary key, member role `owner|admin|member|auditor`, status, inviter, joined time, and timestamps. Registration creates only the owner membership. No current CRUD routes manage additional members.

## Authentication and credentials

### `auth_sessions`

Hashed browser session token, user/session version, expiry/revocation/last-seen timestamps, and hashed IP/user-agent observations. Current code inserts and validates sessions and revokes current/other sessions; it does not update `last_seen_at` after creation.

### `user_totp`

One TOTP envelope per user: encrypted secret JSON, IV, derived key ID, algorithm/digits/period, last-used counter/time, verification and audit timestamps. Enrollment upserts only while unverified.

### `totp_recovery_codes`

Keyed recovery-code hash, user, created and used times. Code hashes are unique; use is conditional on still unused.

### `email_verification_tokens` and `password_reset_tokens`

Token-hash lifecycle tables with expiry/consumption metadata. No current HTTP route sends or consumes these tokens, so they are schema foundations rather than functioning recovery flows.

### `api_keys` and `api_key_scopes`

Track M key hash/prefix/label, machine flag, environment, active/revoked/expiry/use/rotation lifecycle, plus normalized scope rows. `scopes_json` is also stored, so scope state is duplicated; runtime authenticates from JSON.

### `source_keys`

Designed for device/source signing-key lifecycle with external key ID, algorithm, public key, fingerprint, validity/revocation. Current Track M accepts `source_key_id` and `source_signature` but does not resolve or verify this table.

## Plans and billing

### `billing_plans`

Seeded Supplier A/B/C/D plan limits and prices plus legacy `VERIFIER_30D`. The table stores price cents and optional access days but no recurring interval or Stripe Price ID.

### `entitlements`

Time-bounded `writer_plan|read_pass` authorization with optional scope, environment, plan/order/Stripe links, status, per-entitlement write limits, cancellation, and timestamps. Supplier write authorization reads this table. Legacy verifier scope APIs also read it.

### `pending_registrations`

Production pay-before-account staging: identity/profile/password hash, role/mode/plan/scope, Stripe IDs, status/expiry, activation link. The active registration route currently bypasses it.

### `billing_orders`

Legacy Supplier subscription or verifier read-pass order state, amounts, Stripe IDs, plan/scope, lifecycle, and linked entitlement. Used by legacy webhook activation code, not the newer event-type access purchase.

### `stripe_webhook_events`

Idempotency and observability for Stripe event ID/type/object/environment, payload hash, processing state, attempts, errors, and timestamps. The webhook store claims before handling and marks completion/failure.

## Supplier structure and event data

### `supplier_event_types`

Owner/organization-scoped stable event type reference, display name, description, active/archive status, timestamps. Unique per owner and reference.

### `event_instances`

Owner/type-scoped procedure or occurrence instance reference, title, lifecycle, start/end times. Unique per owner, type, and reference.

### `cases`

Track H case identity, owner/organization, eventual chain ID, reference, title/description/category, open/closed lifecycle. `case_ref` is unique per owner and `chain_id` unique when assigned.

### `sources`

Track M Source identity, owner/organization, eventual chain, external reference/label/type, sequence policy/state, lifecycle, metadata, receive and audit timestamps. Unique per owner and external reference.

### `chains`

Owner, `H|M`, external reference, current previous proof, next position, head event, last receive, closed flag, timestamps. Unique logical identity `(owner_id, track, external_ref)`.

### `events`

Core append-only record. It contains chain/owner/position, C, manifest hash, legacy nullable encrypted capsule, previous proof/proof, track/external reference, case/source/type/instance links, action, delivery, occurred/received time, sequence and status, idempotency and credential provenance, request hash, optional source signature, correction target, canonical metadata, anchor projection/batch link, and timestamps.

The current application leaves `encrypted_capsule` null. `event_type` stores the normalized action for both tracks; `action` is also populated for Track M.

### `idempotency_records`

Credential/key/request hash, processing state, response status/body, optional event, expiry, and timestamps. Unique by credential type, credential ID, and idempotency key. Event/source flows use it to replay exact successful responses and reject conflicting bodies.

## Receipts and proof publication

### `receipts`

One current receipt per event: canonical JSON, signature, key ID/algorithm, receipt version, payload hash, environment, mutable anchor projection, issued/created/updated times.

### `receipt_signing_keys`

Environment-bound Ed25519 public-key registry with active/retired/revoked status, activation/retirement and timestamps. Default retrieval creates/registers the configured key after proving private/public correspondence.

### `receipt_versions`

Immutable versioned receipt snapshots intended to capture pending/submitted/anchored/failed states. The schema and triggers exist, but current anchoring code updates `receipts.anchor_status` and does not insert receipt-version rows.

### `evidence_scopes`

Supplier-owned `case|delivery|event_group|event|custom` collection with stable reference, title/summary, draft/published/revoked/archived lifecycle, optional case/delivery links, and publication timestamps.

### `evidence_scope_members`

Ordered event membership with supplier provenance. Maximum 80 is enforced in service code. Published membership is immutable by trigger.

### `shares`

Hashed bearer token, owner and scope, proof/PDF flags, active/revoked/expired lifecycle, optional max views, view count, access/expiry timestamps.

### `share_access_events`

Designed to record allowed/expired/revoked/invalid share attempts with optional hashed client observations. Current `resolveShare` updates counters but does not insert this audit table.

## Current event-type purchase model

### `verifier_invitations`

Supplier/type invitation, hashed token/prefix, optional Verifier user/organization, accepted/revoked/expired lifecycle, and timestamps.

### `access_offers`

Invitation-backed Supplier/type offer with `one_time_range|subscription_28d` and lifecycle.

### `access_orders`

Environment, Verifier, offer/type, model, exact selected/derived range, seven-day count, amount/currency/pricing version, Stripe identifiers, fulfillment state and timestamps.

### `access_grants`

One grant per fulfilled order: Verifier user/organization, Supplier, event type, model, data window, access window, future inclusion boundary, lifecycle, and timestamps.

### `evidence_view_sessions`

Fifteen-minute grant viewing session with authenticated session ID and watermark reference. Current code creates it when listing grant events.

### `evidence_access_logs`

Grant/session/Verifier/event audit action (`list|view|compare|capsule_unwrap|legal_export`), outcome, optional hashed client observations, timestamp. Current code records only `list/allowed`.

### `disclosure_capsules` and `disclosure_key_envelopes`

Schema for server-held encrypted disclosure material and per-Supplier/grant wrapped keys. No current runtime code writes or reads either table. They do not make current verifier purchases decryptable.

### `priority_anchor_requests`

Requester, Supplier, event type/reference, optional access order, time range, pending/batching/completed/failed/cancelled state, batch/error/completion fields. Purchases and Supplier manual requests insert it; the scheduled anchor service consumes it.

## Anchoring

### `anchor_batches`

Environment/batch reference, state, Merkle root, manifest hash, counts, attempts/retry/error, transaction/block/chain/network/contract fields, submission/confirmation and audit timestamps. Batch reference is unique per environment; transaction hash unique when present.

### `anchor_batch_events`

Immutable batch membership: event, leaf index/hash, Merkle proof JSON, created time. Each event may belong to only one batch.

### `anchor_attempts`

Attempt number, state, transaction/error data, submission/completion times. Unique per batch and attempt.

## Counters

### `rate_limit_counters`

Windowed request and record counters by credential and route. Track H and Track M use atomic upserts for per-minute limits.

### `usage_counters`

General metric bucket schema. Current Track M usage reads event counts directly rather than this table.

## Immutability triggers

Migration `0002` prevents:

- deleting a user who owns evidence;
- deleting a chain with events;
- deleting events, receipts, receipt versions, or anchor memberships;
- changing signed event facts, signed receipt facts, anchor membership, or chain identity;
- changing closed-chain state except permitted transition semantics;
- changing protected confirmed/batch facts;
- adding, editing, or removing members of a published scope;
- reopening or mutating protected published-scope facts.

Allowed projection changes include advancing event/receipt anchor status and binding an event to its anchor batch under constrained transitions.

## Deletion behavior

Early schema foreign keys used `ON DELETE CASCADE` for users/chains/events. Later protective triggers and `RESTRICT` relationships are relied upon to preserve evidence. Application code exposes no evidence deletion endpoint.
