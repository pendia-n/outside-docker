# Outside Docker Phase 1 — Should-Be Product Contract

## 1. Authority and Scope

This document defines how Outside Docker (OD) **should work in Phase 1** for:

- **Track H** — human-controlled evidence capture through the web UI.
- **Track M** — machine-generated records submitted through an API.
- **Verifier** — paid, read-only review of a selected evidence scope.

This document consolidates the latest product decisions. Where it conflicts with older planning material such as `od.md`, this document is authoritative for Phase 1.

Phase 1 is an integrity-preservation system. OD proves that a record was captured, linked into an ordered chain, and not changed after capture. It does **not** prove that the original statement, image, sensor reading, or document was truthful.

## 2. Phase 1 Non-Negotiable Boundaries

1. One Cloudflare Worker serves the app and API.
2. `ENV=dev|prod` selects `DB_DEV` or `DB_PROD` inside that Worker.
3. Dev registration writes only to the dev D1 database.
4. Production accounts are created in the prod D1 database only after successful payment.
5. Original files and original machine content are not stored by OD in Phase 1.
6. No original PDF, image, video, telemetry file, or document is stored in R2.
7. The content passcode never leaves the user's browser or local client.
8. Polygon stores only an anchor root and manifest hash, never original content or all encrypted capsules.
9. Every accepted write returns a signed receipt immediately.
10. Every chain append is serialized through a Durable Object to prevent concurrent forks.
11. Track H writes through the web UI.
12. Track M machine records are written through the API; its dashboard is read-only for record data.
13. Verifiers cannot write supplier records.
14. A paid verifier workspace is separate from free verification of a proof deliberately shared by a supplier.
15. Paid users can download their applicable `.odproof` and `.odproof.pdf` artifacts without an additional export fee.

## 3. Roles and Commercial Model

### 3.1 Supplier

A supplier is an organization generating evidence. During onboarding it selects Track H, Track M, or both as its initial operating mode. This selection configures the dashboard; it does not create a separate identity type.

Supplier production access is subscription-based:

| Plan | Write rate | Records per write | Monthly price |
|---|---:|---:|---:|
| A | 2 writes/min | 250 | $99/month |
| B | 4 writes/min | 700 | $299/month |
| C | 10 writes/min | 1,150 | $799/month |
| D | 20 writes/min | 2,000 | $1,999/month |

A supplier account is inserted into production `users` only after the first subscription payment succeeds. Stripe webhook processing must be idempotent.

When the subscription is inactive, expired, unpaid, or canceled:

- New writes are rejected with `402 Payment Required` or `403 Forbidden`, depending on the failure.
- Existing records and receipts remain preserved.
- The supplier can still access billing and account recovery pages.
- Read access to its own records follows the product's retention policy and must not silently delete evidence.

### 3.2 Verifier

A verifier is any person or organization reviewing evidence. A verifier does not need to be a lawyer, regulator, or licensed professional.

Examples include:

- Lawyers and opposing counsel.
- Insurance firms and claims investigators.
- Auditors and regulators.
- Journalists and public-interest monitors.
- Customers, partners, or other third parties reviewing a shared scope.

The production verifier flow is:

1. Select a specific readable scope.
2. Pay **$29** for 30 days of workspace access to that scope.
3. Create the production account after payment succeeds.
4. Obtain read-only access for the paid period.

A scope can represent a human case, a delivery manifest, a machine event group, or another explicitly published evidence set. Buying a second scope creates a separate entitlement. Auto-renewal is off by default and can only be enabled by an explicit user choice.

A verifier does not receive supplier write privileges or a Track M write key.

### 3.3 Free Shared Verification

A supplier may deliberately share a proof or portable capsule with a third party. Verifying that shared artifact is free and must not require a judge, opposing counsel, or recipient to buy a Read Pass.

Free shared verification provides only the minimum needed to verify:

- Receipt signature.
- Hash-chain linkage included in the artifact.
- Manifest membership.
- Polygon anchor root and transaction reference.
- Optional local comparison with an original file supplied by the recipient.

It does not provide:

- Database browsing.
- Search across supplier records.
- Access to unrelated events.
- A verifier workspace.
- Decryption without the separately shared passcode.

## 4. Environment Behavior

### 4.1 Development

- `ENV=dev` selects `DB_DEV`.
- Registration does not require payment.
- Dev usernames are checked only in `DB_DEV`.
- Dev API keys are clearly prefixed, for example `od_sk_dev_...`.
- Dev receipts and anchors are visibly labeled as development artifacts.
- Polygon activity is limited to Amoy testnet.

### 4.2 Production

- `ENV=prod` selects `DB_PROD`.
- Production usernames are checked only in `DB_PROD`.
- A pending registration may exist before payment, but no active production `users` row is created until Stripe confirms payment.
- Stripe webhook event IDs and Checkout/PaymentIntent IDs are unique and idempotent.
- Production API keys use a distinct prefix, for example `od_sk_live_...`.
- Production secrets are Worker secrets, never Wrangler plaintext variables.

## 5. Onboarding and Account Security

### 5.1 Common Registration Fields

Every user chooses:

- `supplier` or `verifier`.
- A unique username.
- A password.
- Optional email.
- Optional TOTP enrollment.

Username rules:

- 3–32 characters.
- Lowercase letters, digits, `_`, and `-` only.
- Availability is checked live against the active environment's D1 database.
- A green tick is shown only after the server confirms availability.
- The database `UNIQUE` constraint remains the final race-safe authority.

Password rules:

- At least 7 characters.
- At least one uppercase letter.
- At least one lowercase letter.
- At least one digit.
- At least one symbol.
- Passwords are stored only as versioned salted hashes.

Email rules:

- Email is optional.
- If supplied, Phase 1 accepts Gmail addresses only.
- The address is normalized before uniqueness checks.
- Email verification is required before using email for recovery or security alerts.

TOTP rules:

- TOTP is optional.
- Enrollment displays a standards-compatible QR code and manual secret.
- Enrollment is not enabled until the user submits one valid code.
- Recovery codes are generated once, hashed in storage, and shown once.
- The content-encryption passcode is unrelated to TOTP and remains client-side.

### 5.2 Supplier-Only Registration Fields

A production supplier must provide:

- Legal organization name.
- Address line 1.
- Optional address line 2.
- City.
- State/region where applicable.
- Postal code.
- Country.
- Initial mode: Track H, Track M, or both.
- Selected supplier plan.

### 5.3 Verifier Registration Fields

A verifier does not need to provide organization or address information. Optional profile fields may include display name and organization, but they must not block registration.

## 6. Cryptographic Data Model

### 6.1 Content Hashing

For a file:

```text
H = SHA-256(exact original bytes)
```

For a string:

```text
H = SHA-256(UTF-8 bytes)
```

For JSON:

```text
canonical = RFC 8785 JSON Canonicalization Scheme
H = SHA-256(UTF-8(canonical))
```

A random 32-byte record salt is generated client-side:

```text
C = SHA-256("OD1|CONTENT|" || salt || H)
```

`H`, `salt`, and the original content are not published on Polygon. The Worker stores `C`, the metadata commitment, chain proof, and receipt data required by the product.

### 6.2 Passcode and Portable Capsule

The passcode is used only by the local browser/client to encrypt and decrypt the portable proof capsule.

Phase 1 capsule encryption:

- KDF: PBKDF2-HMAC-SHA-256.
- Versioned iteration count, initially 310,000.
- Random 16-byte KDF salt.
- Cipher: AES-256-GCM.
- Random 12-byte IV.
- The authenticated data includes the capsule version and record identifier.

The `.odproof` package may contain:

- Version and algorithms.
- Encrypted local evidence payload or encrypted evidence metadata, depending on the user's export choice.
- `H` and record salt inside the encrypted section.
- Server commitment `C`.
- Event proof and previous proof.
- Signed receipt.
- Manifest hash and Merkle proof when anchored.
- Polygon network, contract, transaction, and block references when anchored.

The Worker never receives the passcode. In Phase 1, OD does not retain the original content or the encrypted original-content capsule on its servers. The browser assembles and downloads the portable package locally.

A wrong passcode must fail locally with an authenticated-decryption error and must not reveal partial plaintext.

### 6.3 Hash Chain

Each event uses a versioned domain-separated proof:

```text
proof_n = SHA-256(
  "OD1|EVENT|" ||
  chain_id ||
  position ||
  server_received_at ||
  commitment ||
  previous_proof
)
```

The first event has an empty `previous_proof`. Position and previous proof are assigned by the chain's Durable Object, not trusted from the client.

### 6.4 Signed Receipt

Every accepted write immediately returns a receipt containing at least:

- Receipt version.
- Event ID.
- Chain ID and external reference.
- Track.
- Position.
- Commitment.
- Proof and previous proof.
- Client occurrence time, if provided.
- Server receipt time.
- Current anchor status.
- Signing key ID.

Receipts must use an externally verifiable asymmetric signature, such as Ed25519. A shared HMAC secret is not sufficient for portable third-party verification.

### 6.5 Polygon Anchoring

Polygon receives only batch-level commitments:

- Merkle root.
- Manifest hash.
- Batch identifier.
- Leaf/event counts.
- Contract timestamp.

Polygon must not receive:

- Original content.
- Raw file hash `H`.
- User passcode.
- Per-record ciphertext.
- Personally identifying metadata.

An accepted record begins in `pending_anchor` state. After the batch is anchored and confirmed, the receipt/export becomes `anchored` and includes the Merkle proof and Polygon transaction reference.

## 7. Shared Data and Authorization Model

Minimum Phase 1 entities:

- `pending_registrations`
- `users`
- `organizations`
- `entitlements`
- `api_keys`
- `sources`
- `chains`
- `events`
- `receipts`
- `anchor_batches`
- `shares`
- `stripe_webhook_events`

Minimum event fields:

- `id`
- `owner_id`
- `track`
- `chain_id`
- `external_ref`
- `event_type` or `action`
- `source_id` where applicable
- `delivery_id` where applicable
- `occurred_at`
- `received_at`
- `sequence`
- `idempotency_key`
- `commitment`
- `manifest_hash`
- `previous_proof`
- `proof`
- `position`
- `anchor_status`

Authorization rules:

| Capability | Track H supplier | Track M supplier | Verifier | Free share recipient |
|---|---:|---:|---:|---:|
| Manage account and billing | Yes | Yes | Yes | No |
| Create human event through UI | Yes | No | No | No |
| Create machine record through API | No | Yes | No | No |
| Browse own supplier records | Yes | Yes, read-only dashboard | No | No |
| Browse paid verifier scope | No | No | Yes | No |
| Verify deliberately shared artifact | Yes | Yes | Yes | Yes |
| Download permitted `.odproof.pdf` | Yes | Yes | Yes | Only if included in the share |

Every protected request rechecks the user, active entitlement, role, scope, and credential status. A valid 28-day session cookie alone is not sufficient authorization for billing-sensitive operations.

## 8. Track H — Human Evidence Through the Web UI

### 8.1 Dashboard

A Track H supplier dashboard provides:

- Cases.
- Case timeline.
- New event form.
- Receipt and anchor status.
- Export/download.
- Share management.
- Billing and plan status.
- Account security.

### 8.2 Create a Case

The supplier creates a case with:

- Unique `case_ref` within the organization.
- Title.
- Optional non-sensitive description.
- Optional category.

Examples:

- Healthcare incident.
- Logistics shipment or dispute.
- Internal investigation.
- Insurance claim evidence package.

Case metadata must avoid unnecessary personal or confidential data. A pseudonymous reference is preferred.

### 8.3 Add an Event

The supplier:

1. Opens a case.
2. Selects an event type.
3. Selects a local file or enters structured metadata.
4. The browser reads and hashes the file locally.
5. The original file is never uploaded to OD.
6. The browser creates `H`, salt, and commitment `C`.
7. If a portable capsule is requested, the browser asks for a passcode and encrypts it locally.
8. The browser submits only the commitment and allowed metadata.
9. The Worker authorizes the supplier and active plan.
10. The Durable Object serializes the append.
11. D1 stores the event and receipt.
12. The response includes the signed receipt.
13. The browser offers `.odproof` download immediately.
14. After anchoring, the browser offers an updated anchored artifact and `.odproof.pdf`.

Corrections never mutate an earlier event. They are appended as a new event referencing the event being corrected.

### 8.4 Healthcare Nurse Case

Example case:

```text
case_ref: CARE-INCIDENT-2026-001
```

Possible events:

- `SHIFT_RECORD_CAPTURED`
- `MEDICATION_RECORD_CAPTURED`
- `INCIDENT_REPORTED`
- `SUPERVISOR_REVIEWED`
- `CORRECTION_APPENDED`

The UI must discourage patient names and direct identifiers in metadata. The clinical document remains outside OD; OD stores only integrity commitments and proof metadata.

### 8.5 Logistics Manager Case

Example case:

```text
case_ref: SHIPMENT-2026-00091
```

Possible events:

- `ORDER_ACCEPTED`
- `BILL_OF_LADING_CAPTURED`
- `PICKUP_CONFIRMED`
- `WAREHOUSE_HANDOVER_CONFIRMED`
- `DELIVERY_EXCEPTION_REPORTED`
- `DELIVERY_CONFIRMED`
- `CLAIM_OPENED`
- `CLAIM_RESOLVED`

Each meaningful state transition is a separate event. A whole shipment must not be repeatedly overwritten as one large mutable JSON object.

## 9. Track M — Machine Records Through the API

### 9.1 UI Responsibilities

A Track M user still uses the web UI to:

- Register the supplier account.
- Enter organization and address.
- Purchase and manage the subscription.
- Create and revoke API keys.
- Register or inspect machine sources.
- View usage, receipts, chains, errors, and anchor status.
- Configure account security.

The Track M dashboard must not contain a form for manually entering machine records. Record data is read-only in the dashboard.

### 9.2 API Key Lifecycle

A Track M API key is available only while the supplier has a valid paid plan.

- The plaintext key is displayed once.
- D1 stores only a cryptographic hash of the key.
- Keys have labels and scopes.
- Keys can be rotated and revoked.
- Revocation takes effect immediately.
- A canceled plan disables machine writes even if the key itself has not expired.
- Keys are environment-specific.
- A machine-write key cannot access verifier scopes or billing operations.

Recommended scopes:

- `source:write`
- `record:write`
- `record:batch`
- `receipt:read`
- `usage:read`

### 9.3 Machine API

Minimum endpoints:

```text
POST   /api/v1/sources
GET    /api/v1/sources
GET    /api/v1/sources/:source_id
POST   /api/v1/records
POST   /api/v1/records:batch
GET    /api/v1/receipts/:event_id
GET    /api/v1/sources/:source_id/chain
GET    /api/v1/deliveries/:delivery_id/events
GET    /api/v1/usage
```

Every write requires:

```text
Authorization: Bearer od_sk_...
Idempotency-Key: stable-client-generated-value
```

The API must return the same logical result when the same idempotency key and body are retried. Reusing the key with a different body returns `409 Conflict`.

### 9.4 Supported Machine Inputs

Track M commonly records structured JSON and small strings. It may also reference a file generated by a machine or server.

- JSON: canonicalize with RFC 8785, then hash.
- String: hash exact UTF-8 bytes.
- File: the customer's gateway hashes the local file and sends `content_hash`; OD does not receive the file.

The API must not accept a local filesystem path because a Cloudflare Worker cannot read a customer's local disk. It also must not fetch arbitrary user-supplied URLs in Phase 1, which would create SSRF and content-retention risks.

A later CLI helper may accept `--file` locally, calculate SHA-256, and submit only the hash. That helper is outside the Phase 1 server contract unless separately requested.

### 9.5 Machine Record Shape

Example:

```json
{
  "source_id": "drone-07",
  "delivery_id": "DEL-2026-0909-001",
  "action": "PICKUP_CONFIRMED",
  "occurred_at": "2026-09-09T09:51:20Z",
  "sequence": 14,
  "content_hash": "sha256:...",
  "params": {
    "mission_id": "MISSION-2026-0909-001"
  },
  "metadata": {
    "firmware": "v2.1.3"
  },
  "source_key_id": "drone-key-2026-01",
  "source_signature": "optional-ed25519-signature"
}
```

The server records both:

- `occurred_at` — claimed source time.
- `received_at` — authoritative OD server receipt time.

Clock skew is preserved and reported; it is not silently rewritten.

### 9.6 Delivery Drone Case

The preferred architecture is:

```text
Drone -> signed local event -> company fleet gateway/server -> OD API
```

A long-lived OD API key should not be embedded directly in the drone. The gateway validates the device event, canonicalizes it, queues retries, and submits it to OD.

Use one source chain per drone or other stable machine source:

```text
chain external_ref = drone-07
```

Use `delivery_id` to group records belonging to one delivery.

For ten deliveries per day, do not create only ten opaque records containing the entire delivery lifecycle. Record each meaningful state transition, for example:

- `ORDER_ACCEPTED`
- `PICKUP_CONFIRMED`
- `TAKEOFF`
- `EN_ROUTE`
- `ARRIVAL_GEOFENCE_REACHED`
- `HANDOFF_CONFIRMED`
- `RETURN_STARTED`
- `LANDED`

Ten deliveries with six to eight meaningful transitions produce approximately 60–80 records per day. This is appropriate. Do not create one OD event for every raw GPS or sensor sample. Hash a telemetry batch or manifest and reference that hash from a meaningful state event.

At completion, append a delivery manifest event containing the ordered proof IDs for that delivery. This provides a separately exportable delivery evidence set without breaking the source chain.

If connectivity is unavailable:

1. The drone or gateway assigns a monotonic sequence number.
2. The record is signed locally where supported.
3. It is queued durably by the customer.
4. It is uploaded later with the original `occurred_at`.
5. OD records the later `received_at`.
6. Duplicate retries are absorbed by the idempotency key.
7. Out-of-order sequence numbers are accepted only according to an explicit source policy and visibly flagged.

## 10. Verifier Workspace

### 10.1 Purchase and Access

A verifier:

1. Opens a supplier-provided invitation or selects an available evidence scope.
2. Reviews the scope identifier and summary.
3. Pays $29 for 30 days.
4. Creates or activates the verifier account after payment confirmation.
5. Uses a read-only dashboard for that scope.

An existing verifier can buy additional scopes. Each entitlement has its own `valid_from`, `valid_until`, and optional explicit auto-renew setting.

### 10.2 Read-Only Dashboard

The verifier dashboard shows only events in the paid scope:

- Event order.
- Event type or machine action.
- Claimed occurrence time.
- OD receipt time.
- Commitment.
- Proof and previous proof.
- Chain integrity result.
- Anchor state.
- Merkle proof.
- Polygon transaction and block when anchored.
- Receipt signature status.
- Export controls.

It does not expose original content because OD does not store it. The supplier must separately provide the original file or portable encrypted capsule and, where appropriate, the passcode.

### 10.3 Lawyer Case

A lawyer can:

- Read the paid case scope.
- Inspect the event timeline and chain status.
- Verify a supplied original document locally.
- Download `.odproof` and `.odproof.pdf` without an extra export fee.
- Share a minimal free verification artifact with a judge or opposing counsel.

The UI must say that integrity verification does not establish substantive truth or legal admissibility.

### 10.4 Insurance Firm Case

An insurer can:

- Buy access to a shipment, claim, or delivery evidence scope.
- Review human events and machine records included in that scope.
- Compare occurrence and receipt timestamps.
- Inspect chain and anchor status.
- Export a report for its claim file.

The insurer cannot browse unrelated deliveries or the supplier's entire account.

## 11. Durable Object Chain Serialization

Each logical chain is owned by one Durable Object instance keyed from:

```text
owner_id + track + external_ref
```

The Durable Object must:

1. Validate idempotency.
2. Load or initialize the chain head.
3. Assign the next position.
4. Compute the new proof from the current head.
5. Persist chain, event, and receipt state atomically as far as the platform permits.
6. Advance the head only after successful persistence.
7. Return the signed receipt.

D1 unique constraints remain as a second line of defense:

- Unique `(chain_id, position)`.
- Unique proof.
- Unique `(owner_id, track, external_ref)`.
- Unique `(credential_id, idempotency_key)`.

## 12. Payments and Entitlements

### 12.1 Supplier

- Stripe Checkout creates the initial subscription payment.
- The account remains pending until a verified webhook confirms payment.
- The webhook inserts or activates the production user, organization, subscription entitlement, and selected plan atomically and idempotently.
- Subscription status changes update the entitlement.
- Failed or replayed webhooks must not create duplicate accounts or entitlements.

### 12.2 Verifier

- Stripe creates a one-time $29 payment for one selected 30-day scope.
- The webhook creates the verifier account if necessary and activates the scoped entitlement.
- Repeated webhook delivery must not extend the pass twice.
- Auto-renew is disabled unless explicitly chosen.

### 12.3 Authorization

Every write or paid read checks the entitlement at request time. UI visibility is not an authorization control.

## 13. Required Error and Edge-Case Behavior

- Username becomes unavailable after a green tick: registration returns `409`; UI asks for another username.
- Wrong password: generic `401`; no account-existence leak.
- Wrong TOTP: login fails without creating a session.
- Wrong content passcode: local AES-GCM authentication failure; Worker is not contacted with the passcode.
- Expired supplier plan: machine and human writes return payment/entitlement error.
- Expired verifier pass: workspace closes for that scope, but free shared-artifact verification still works.
- Verifier attempts a write: `403 Forbidden`.
- Track H supplier attempts Track M API without entitlement/key scope: `403 Forbidden`.
- Duplicate machine retry: same result returned; no second event.
- Same idempotency key with different content: `409 Conflict`.
- Concurrent appends: serialized by the chain Durable Object.
- Unanchored event: receipt is valid but clearly labeled `pending_anchor`.
- Failed Polygon transaction: event remains preserved and queued for retry; no false anchored status.
- Tampered portable artifact: verification fails at the exact failed layer.
- Original file unavailable: chain and receipt can still be verified, but content equality cannot be proven.
- Arbitrary remote URL submission: rejected; Phase 1 does not fetch user URLs.
- Stripe webhook replay: acknowledged idempotently without duplicate state.
- D1 write failure: no successful receipt is returned.
- Out-of-order machine sequence: flagged according to source policy and never silently reordered.

## 14. Phase 1 Definition of Done

Phase 1 is complete only when all of the following are implemented and verified in dev:

- Role-aware onboarding.
- Username availability and database uniqueness.
- Password and optional TOTP authentication.
- Dev/prod D1 isolation.
- Payment-gated production account creation.
- Supplier subscription entitlements.
- Scoped verifier Read Pass entitlements.
- Track H case and event UI.
- Local file hashing and local passcode encryption.
- No original-content server storage.
- Track M API keys, sources, records, batching, and idempotency.
- Track M read-only record dashboard.
- Verifier read-only scoped dashboard.
- Durable Object chain serialization.
- Asymmetrically signed receipts.
- `.odproof` and `.odproof.pdf` export.
- Merkle batching and Polygon root/manifest anchoring.
- Free verification of deliberately shared artifacts.
- Live browser and API tests for nurse, logistics, drone, lawyer, and insurer journeys.

Until those checks pass, the product must be described as a partial Phase 1 implementation rather than a complete OD application.
