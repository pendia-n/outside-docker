# Outside Docker — Current-State Review and Resolved Inadequacies

## 1. Purpose

This document records what the deployed Outside Docker code currently does, what the simulated user journeys exposed, and how those inadequate cases were resolved at the product-design level.

It is a **current-state audit**, not a claim that the target features are implemented. The Phase 1 target contract is in `SHOULD-BE.md`.

## 2. Executive Verdict

The current deployment is a working **Phase 1 foundation**, not a complete Track H, Track M, or Verifier product.

Verified working foundation:

- One Hono Cloudflare Worker.
- `DB_DEV` and `DB_PROD` bindings selected by `ENV`.
- Current environment is dev.
- Public landing page.
- OD logo and favicon.
- Username availability check.
- Dev supplier/verifier registration.
- Supplier organization/address capture.
- Password hashing.
- JWT httpOnly cookie login.
- Session lookup.
- One generic commitment-writing endpoint.
- D1 tables for users, organizations, entitlements, API keys, chains, events, and receipts.
- Polygon Amoy contract address is configured.

Not implemented:

- Track H case/event dashboard.
- Track M machine API.
- API key issuance/authentication.
- Verifier reader dashboard.
- Stripe payments.
- Supplier subscription enforcement.
- Scoped verifier Read Pass.
- TOTP enrollment and challenge.
- Client-side file hashing workflow.
- Client-side passcode encryption/decryption.
- Durable Object serialization.
- Merkle batching.
- Actual Polygon anchor transactions from the Worker.
- Portable `.odproof` export.
- `.odproof.pdf` export.
- Free shared-artifact verification.

The app can currently demonstrate registration, login, and a basic hash-chain write. It cannot complete any of the five simulated customer journeys end to end.

## 3. Current Deployment and Route Reality

Current Worker:

```text
outside-docker-sol-app
```

Current live application:

```text
https://outside-docker-sol-app.pendia-community.workers.dev/
```

Current route inventory:

```text
GET  /health
GET  /api/username/:username
POST /api/register
POST /api/login
POST /api/logout
GET  /api/session
POST /api/commitment
GET  /
```

Observed live behavior:

```text
GET  /health          -> 200
GET  /api/session     -> 401 when unauthenticated
POST /api/commitment  -> 401 when unauthenticated
POST /record          -> 404
GET  /verify/test     -> 404
```

Routes described in older product material but absent from current code include:

```text
POST /event
POST /record
GET  /case/:ref/chain
GET  /verify/:proof
GET  /verify/public/:proof
GET  /case/:ref/export
```

## 4. Current Code Structure

The application is concentrated in a small number of files:

```text
sol-app/src/index.tsx
sol-app/src/crypto.ts
sol-app/src/types.ts
sol-app/src/renderer.tsx
sol-app/src/style.css
sol-app/migrations/0001_init.sql
sol-app/wrangler.jsonc
```

`src/index.tsx` currently contains:

- Environment/D1 selection.
- Error handling.
- All API routes.
- Registration and login logic.
- Generic commitment append logic.
- The complete server-rendered landing page.
- Inline browser JavaScript for account forms.

This is acceptable as an early scaffold but is not yet separated into billing, authorization, Track H, Track M, verifier, anchoring, and receipt modules.

## 5. Current Environment and Database Selection

The Worker binds both:

```text
DB_DEV
DB_PROD
```

The helper selects one database from:

```text
ENV=dev|prod
```

Current configuration uses:

```text
ENV=dev
POLYGON_CHAIN_ID=80002
```

This satisfies the one-Worker/two-D1 architecture. It does not yet satisfy payment-gated production onboarding because production registration currently returns an error instead of launching or completing payment.

## 6. Current Registration Flow

### 6.1 Username Check

The browser calls:

```text
GET /api/username/:username
```

The Worker:

1. Normalizes the username to lowercase.
2. Enforces a 3–32-character pattern using lowercase letters, numbers, `_`, and `-`.
3. Queries the active D1 database.
4. Returns `available: true|false`.

The UI can display a green availability tick. The final database `UNIQUE` constraint still controls race safety.

### 6.2 Account Creation

The browser calls:

```text
POST /api/register
```

Current behavior:

1. Rejects registration unless `ENV=dev`.
2. Validates username.
3. Validates password complexity.
4. Accepts role `supplier` or `verifier`.
5. Requires organization and address fields for suppliers.
6. Hashes the password.
7. Inserts the user into the active D1 database.
8. Inserts one organization row for a supplier.
9. Returns JSON.

Current password requirements:

- Minimum seven characters.
- Uppercase.
- Lowercase.
- Digit.
- Symbol.

Current gaps:

- No Stripe Checkout.
- No pending production registration.
- No account creation from a payment webhook.
- No supplier plan selection.
- No verifier scope selection.
- No verifier payment.
- No Gmail-only validation.
- No email verification.
- No TOTP enrollment.
- No automatic login after registration.
- No role-specific dashboard redirect.

## 7. Current Login and Session Flow

The browser calls:

```text
POST /api/login
```

The Worker:

1. Looks up the user.
2. Checks `is_active` during login.
3. Verifies the PBKDF2 password hash.
4. Creates an HS256 JWT.
5. Stores it in the `od_session` httpOnly cookie.

Cookie characteristics:

- 28-day lifetime.
- `SameSite=Strict`.
- `Secure` in production.
- `httpOnly`.

`GET /api/session` verifies the cookie and returns claims.

Current gaps:

- Session authorization does not re-query D1 on every protected operation.
- A user disabled after login may retain access until the JWT expires.
- Current protected writes do not check role or entitlement.
- There is no session revocation list or security-session management UI.
- There is no TOTP challenge.
- Successful login returns JSON instead of opening a real dashboard.

## 8. Current Password and Proof Cryptography

### 8.1 Password Hash

The current code uses:

```text
PBKDF2-HMAC-SHA-256
100,000 iterations
random 16-byte salt
```

Stored format:

```text
pbkdf2-sha256$v=1$i=100000$<salt>$<digest>
```

This was selected because the deployed Workers runtime rejected the attempted WASM Argon2 implementation and caps the accepted Web Crypto PBKDF2 iteration count in this path.

### 8.2 Generic Content Helper

`src/crypto.ts` contains:

```text
contentCommitment(contentHash, secretSalt)
```

It computes a SHA-256 domain-separated commitment. The current `/api/commitment` route does not call it. The browser also does not currently implement the corresponding file hashing and salt generation.

### 8.3 Current Event Proof

The current event proof is:

```text
SHA-256("OD1-EVENT|" + position + createdAt + commitment + previousProof)
```

The route trusts the client-provided `commitment` and `manifest_hash`. It does not receive or hash an original file, which correctly avoids storing content but also means the current app does not prove how those supplied values were produced.

## 9. Current Commitment Write Flow

The browser or client calls:

```text
POST /api/commitment
```

Current request fields:

```json
{
  "track": "H",
  "chain_ref": "case-or-source-reference",
  "commitment": "client-provided-value",
  "manifest_hash": "client-provided-value",
  "encrypted_capsule": "optional-arbitrary-string"
}
```

Current processing:

1. Verify the session cookie.
2. Accept `track` as `H` or `M`.
3. Find the chain by owner, track, and external reference.
4. Read the current previous proof and next position.
5. Compute the new event proof.
6. Insert or update the chain.
7. Insert the event.
8. Insert the receipt.
9. Return event, chain, proof, receipt, signature, and configured Polygon contract address.

Current deficiencies:

- No supplier-role check.
- No active-plan check.
- A verifier session can reach the same write path.
- No API key authentication.
- No Track H case model.
- No Track M source/action model.
- No idempotency key.
- No client occurrence time.
- No source sequence.
- No source signature.
- No content hash validation.
- No manifest validation.
- `encrypted_capsule` is an unchecked string and is stored in D1.
- No Durable Object protects the append.
- No actual Polygon transaction occurs.
- No Merkle proof is generated.

## 10. Current D1 Schema

Existing tables:

```text
users
organizations
entitlements
api_keys
chains
events
receipts
```

### 10.1 Useful Existing Foundations

- Unique username.
- Supplier/verifier role check.
- Supplier organization linked to user.
- Entitlement type supports `writer_plan` and `read_pass`.
- Entitlement has scope, validity, and auto-renew fields.
- API key table stores only `key_hash`, not plaintext.
- Chain uniqueness is enforced by owner, track, and external reference.
- Event position is unique within a chain.
- Receipt is unique per event.

### 10.2 Missing or Inadequate Schema

Missing entities or fields include:

- Pending production registration.
- Stripe customer/subscription/payment identifiers.
- Processed Stripe webhook event IDs.
- TOTP encrypted secret and hashed recovery codes.
- API key prefix, scopes, last-used time, expiration, and revocation time.
- Track M sources.
- Track H case metadata.
- `event_type`.
- `action`.
- `source_id`.
- `delivery_id`.
- `occurred_at` distinct from `received_at`.
- Source sequence.
- Idempotency key and request-body fingerprint.
- Source signature/key ID.
- Anchor batch and Merkle proof data.
- Share scope and free-verification token.
- Receipt public-signing key metadata.

## 11. Current Receipt Limitation

The current receipt signature uses the same HS256 JWT mechanism as sessions and labels the signing key as:

```text
dev-jwt-hs256
```

This is not a portable public signature because a verifier would need the shared HMAC secret. A production portable receipt should use an asymmetric signing key so that anyone can verify with the public key without being able to forge receipts.

## 12. Current Polygon Limitation

The current Worker response includes the configured Polygon contract address. It does not:

- Build a Merkle tree.
- Build a batch manifest.
- Submit an anchor transaction.
- Record a transaction hash or block number.
- Wait for confirmations.
- Retry failed anchors.
- Attach Merkle proofs to events.

The Amoy contract exists, but the application anchoring pipeline is not implemented.

## 13. Current Concurrency Risk

The append path currently performs a read followed by D1 writes:

```text
read chain head
-> compute next position and proof
-> write chain/event/receipt
```

Two concurrent requests can read the same head and calculate the same position. Database uniqueness may reject one request, but this is not a complete chain-serialization strategy and can create failed retries or inconsistent client expectations.

Resolved design decision:

```text
One Durable Object serializes every logical chain.
```

D1 uniqueness remains a backup constraint rather than the primary concurrency mechanism.

## 14. Simulated Case: Healthcare Nurse, Track H

### Intended Task

A nurse or healthcare organization captures an incident report, medication record, shift record, or supporting PDF/image and receives a tamper-evident event receipt.

### What the Current App Can Do

1. Register a dev supplier.
2. Enter organization and address.
3. Log in.
4. Receive JSON confirming login.

### Where It Fails

- No case creation.
- No healthcare incident timeline.
- No file picker connected to hashing.
- No local SHA-256 operation.
- No client-side passcode encryption.
- No event-type selection.
- No signed portable receipt download.
- No `.odproof`.
- No `.odproof.pdf`.
- No share flow.
- No verifier access.

### Resolved Design

- Use Track H web UI.
- Create a pseudonymous healthcare case.
- Hash the selected file locally.
- Never upload the original file to OD.
- Append each meaningful record or correction as a separate event.
- Do not place patient names or sensitive medical content in public metadata.
- Generate the portable proof package in the browser.

Result: the current app cannot yet perform the nurse workflow.

## 15. Simulated Case: Logistics Manager, Track H

### Intended Task

A logistics manager builds a chain for a shipment, handover, delivery exception, or insurance dispute.

### What the Current App Can Do

The same registration and login foundation as the nurse case.

### Where It Fails

- No shipment/case object.
- No bill-of-lading hash flow.
- No ordered event timeline.
- No delivery exception event.
- No claim scope.
- No chain report.
- No insurer invitation.

### Inadequate Design Avoided

Storing a whole shipment as one repeatedly modified JSON object would make lifecycle changes opaque and weaken sequence evidence.

### Resolved Design

Use one human case chain and append meaningful events such as:

```text
ORDER_ACCEPTED
BILL_OF_LADING_CAPTURED
PICKUP_CONFIRMED
WAREHOUSE_HANDOVER_CONFIRMED
DELIVERY_EXCEPTION_REPORTED
DELIVERY_CONFIRMED
CLAIM_OPENED
CLAIM_RESOLVED
```

Result: the current app cannot yet perform the logistics workflow.

## 16. Simulated Case: Delivery Drone Company, Track M

### Intended Task

A drone company records ten deliveries per day, including receipt of order, pickup, flight, delivery, verification, return, and landing stages.

### What the Current App Can Do

A supplier can register and log in. The generic commitment endpoint accepts `track: "M"` through a cookie session.

### Where It Fails

- `/record` returns 404.
- No API key can be created.
- No Bearer-key middleware exists.
- No source/drone can be registered.
- No `action`, `delivery_id`, sequence, or occurrence time is stored.
- No batch endpoint.
- No idempotency.
- No offline retry contract.
- No read-only Track M dashboard.
- No plan enforcement.

### Inadequate Design Avoided: Direct Drone API Key

Putting a long-lived OD key directly into a drone makes hardware compromise an account compromise and complicates rotation.

Resolved design:

```text
Drone -> signed local event -> company gateway/server -> OD API
```

The company gateway owns the OD key, validates device messages, canonicalizes records, queues retries, and submits them.

### Inadequate Design Avoided: One Opaque Record Per Delivery

One record containing every stage loses clear event timing and independently verifiable state transitions.

Resolved design:

- One stable source chain per drone.
- One record per meaningful transition.
- `delivery_id` groups records for a delivery.
- A final delivery-manifest event lists the ordered proofs.
- Raw GPS/sensor samples are batched into a telemetry manifest instead of becoming one OD event per sample.

Ten deliveries with six to eight state transitions produce approximately 60–80 records per day. That is an appropriate event volume.

### Inadequate Design Avoided: Sending a Local File Path

A Cloudflare Worker cannot read a customer's local file path. Fetching arbitrary remote URLs would create SSRF and content-retention risk.

Resolved design:

- Customer gateway hashes files locally.
- JSON is canonicalized before hashing.
- Strings are hashed as exact UTF-8.
- OD receives the hash/commitment, not the file or path.

Result: the current app cannot yet perform the Track M workflow.

## 17. Simulated Case: Lawyer, Verifier

### Intended Task

A lawyer selects a case/evidence scope, pays $29 for 30 days, reads the chain, verifies it, downloads proof artifacts, and shares a minimal verification package with a court or opposing counsel.

### What the Current App Can Do

1. Register as a dev verifier.
2. Log in.
3. Receive JSON confirming login.

### Where It Fails

- No scope selection.
- No payment.
- No Read Pass activation.
- No verifier dashboard.
- No event list.
- No chain verification endpoint.
- No Merkle verification.
- No Polygon verification.
- No `.odproof` download.
- No `.odproof.pdf` download.
- No free shared-verification page or local verifier.

### Resolved Design

- Verifier access is read-only and scoped.
- The verifier pays $29 for 30 days for the selected scope.
- Auto-renewal is off unless explicitly selected.
- A paid user downloads applicable proof artifacts without an additional export charge.
- A judge or opposing counsel can verify a deliberately shared artifact for free.
- OD must state that integrity does not prove substantive truth or guarantee admissibility.

Result: the current app cannot yet perform the lawyer workflow.

## 18. Simulated Case: Insurance Firm, Verifier

### Intended Task

An insurer buys access to a claim, shipment, delivery, or event scope and reviews both human and machine evidence included in that scope.

### What the Current App Can Do

Only verifier registration and login.

### Where It Fails

- No claim/event scope.
- No payment or entitlement.
- No cross-track evidence view.
- No occurrence-versus-receipt timestamp comparison.
- No chain or anchor status.
- No report export.
- No access isolation between scopes.

### Resolved Design

- One entitlement grants access only to its selected evidence scope.
- Human and machine records may be included in the same published scope.
- The insurer cannot browse unrelated supplier records.
- The report clearly separates source-claimed time from OD receipt time.

Result: the current app cannot yet perform the insurer workflow.

## 19. Resolved Product Decisions from the Simulations

### 19.1 UI versus API

- Track H writes through the web UI.
- Track M records are written through the API.
- Track M UI handles signup, billing, keys, sources, usage, and read-only inspection.
- Verifier UI is read-only.

### 19.2 Content Storage

- Original content is not stored in D1 or R2 in Phase 1.
- Hashes, commitments, proofs, receipts, and anchor metadata are stored.
- Encoding an image as an RGB-array string does not solve storage or trust problems; it is still the original content in a larger, less efficient form.
- Image arrays must not be used as a substitute for image storage.

### 19.3 Passcode

- Encryption and decryption are client-side.
- The Worker never receives the passcode.
- A portable `.odproof` capsule is assembled locally.

### 19.4 Polygon

- Polygon stores only the batch root and manifest hash.
- It does not store every ciphertext, original hash, or original record.

### 19.5 Receipts

- Every accepted write returns a signed receipt before anchoring.
- Anchoring later augments the proof with Merkle and Polygon data.
- Portable receipt verification requires asymmetric signatures rather than the current shared-secret HMAC.

### 19.6 Chain Concurrency

- One Durable Object serializes each logical chain.
- D1 uniqueness remains the final database guard.

### 19.7 Verification and Billing

- Paid Read Pass: workspace access to a selected scope for 30 days.
- Free verification: minimal verification of a deliberately shared artifact.
- Judges and third parties are not charged merely to validate a shared proof.
- Free verification does not provide unrestricted database browsing.

### 19.8 Supplier and Verifier Identity

- Supplier production onboarding requires organization and address.
- Verifier onboarding does not require those fields.
- A verifier does not need to hold any professional license.

## 20. Findings Ordered by Severity

### P0 — Missing Authorization Boundary

Evidence:

- `/api/commitment` checks only the session cookie.
- It does not check supplier role or active plan.

Impact:

- A dev verifier session can access the same write path.
- Billing requirements are not enforced.

Required correction:

- Central role/scope/entitlement middleware for every protected operation.

### P0 — Track M Does Not Exist as an API

Evidence:

```text
POST /record -> 404
```

Impact:

- Machine customers cannot use the product.

Required correction:

- API key lifecycle, source model, `/records`, batching, idempotency, usage, and receipts.

### P0 — Verifier Product Does Not Exist

Evidence:

```text
GET /verify/test -> 404
```

Impact:

- Lawyers, insurers, auditors, and other readers cannot read or verify evidence.

Required correction:

- Scoped entitlements, read APIs, read-only dashboard, exports, and free shared-artifact verification.

### P0 — Production Payment Flow Does Not Exist

Evidence:

- Production registration returns `402` with a placeholder message.
- No Stripe routes or webhooks exist.

Impact:

- No production account can be created through the intended flow.

Required correction:

- Pending registration plus idempotent supplier subscription and verifier payment webhooks.

### P1 — Client-Provided Commitments Are Unverified

Evidence:

- `/api/commitment` accepts commitment and manifest hash as strings.
- The content commitment helper is unused.

Impact:

- The current app cannot show how a proof was derived from an original file or canonical payload.

Required correction:

- Track H browser hashing and Track M canonical hashing contract, with portable local verification.

### P1 — Arbitrary Capsule Storage

Evidence:

- `encrypted_capsule` is accepted without size, type, or encryption validation and stored in D1.

Impact:

- A client could store plaintext or oversized sensitive content, violating the no-content-storage boundary.

Required correction:

- Do not retain original-content capsules server-side in Phase 1. Build/download them locally.

### P1 — Concurrent Append Race

Evidence:

- Current chain head is read before the D1 batch write.

Impact:

- Concurrent requests can calculate the same next position.

Required correction:

- Serialize each chain through a Durable Object and keep D1 unique constraints.

### P1 — Receipt Is Not Publicly Portable

Evidence:

- Receipt signature uses the session HS256 function and a dev signing-key label.

Impact:

- Third parties cannot verify without the shared secret.

Required correction:

- Asymmetric receipt signatures with a published verification key.

### P1 — Polygon Is Configuration Only

Evidence:

- The response exposes a contract address, but no Worker code sends transactions.

Impact:

- No event is currently anchored by the application.

Required correction:

- Merkle batch, manifest, transaction, confirmation, retry, and proof update pipeline.

### P1 — Session Does Not Recheck Current Account State

Evidence:

- Session verification validates JWT signature and expiration only.

Impact:

- Disabled users or changed entitlements may remain effective until token expiry.

Required correction:

- Recheck active user and entitlement for protected reads/writes.

### P1 — TOTP and Email Rules Are Incomplete

Evidence:

- `totp_enabled` exists, but no secret, enrollment, challenge, or recovery flow exists.
- Email accepts arbitrary values.

Impact:

- Optional security and Gmail-only requirements are not met.

Required correction:

- Complete TOTP enrollment/challenge and optional verified Gmail handling.

### P2 — Code Is Still a Single MVP Module

Evidence:

- Routes, HTML, inline script, auth, and domain writes share `src/index.tsx`.

Impact:

- Further billing, role, and API additions will become difficult to review safely.

Required correction:

- Split only when implementing the actual slices: auth, billing, Track H, Track M, verifier, and anchoring. Do not create speculative framework layers.

## 21. What Must Not Be Claimed Yet

The current app must not be described as having:

- A complete Phase 1 product.
- Track H file capture.
- Track M machine ingestion.
- API key authentication.
- Paid supplier subscriptions.
- Verifier Read Passes.
- Durable Object chain safety.
- Merkle proofs.
- Active Polygon anchoring.
- Publicly verifiable signed receipts.
- `.odproof` or `.odproof.pdf` exports.
- Court-ready or compliance-certified evidence.

Accurate current description:

> Outside Docker currently has a deployed dev foundation with onboarding, password/session authentication, environment-specific D1 selection, and a generic commitment-chain write endpoint. The role-specific Track H, Track M, verifier, payment, client-side cryptography, chain serialization, export, and anchoring flows remain to be implemented.

## 22. Minimum Implementation Order from Here

1. Replace the generic authorization assumption with central role and entitlement checks.
2. Add production pending registration and idempotent Stripe activation.
3. Add Track H case/event data and browser-local hashing.
4. Add API key issuance and Track M sources/records/idempotency.
5. Add Durable Object chain serialization before accepting concurrent production writes.
6. Add verifier scope purchase and read-only dashboard.
7. Add asymmetric receipts and local `.odproof` generation.
8. Add Merkle/Polygon anchoring and anchored artifact updates.
9. Add `.odproof.pdf` and free shared-artifact verification.
10. Run complete browser/API acceptance journeys for nurse, logistics manager, drone company, lawyer, and insurer.

That sequence closes the real product gaps without pretending that the current scaffold already implements the older design documents.
