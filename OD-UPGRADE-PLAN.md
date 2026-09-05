# Outdock Upgrade Plan

## 1. Status and authority

This document is the proposed upgrade plan for **Outdock** (renamed from Outside Docker) after the September 2026 product review. It supersedes conflicting product assumptions in `SHOULD-BE.md`, `NOW-THAT.md`, `design.md`, and `od.md` for the scope described here. It is a plan, not a claim that these upgrades are implemented.

Decisions already established:

- Track H supports human evidence through both the web UI and an authenticated API.
- Track M accepts machine records only through scoped API credentials. Its web workspace is for configuration and read-only inspection, not manual machine-record creation.
- A Supplier may operate Track H, Track M, or both under one Supplier identity.
- OD must not pretend a commitment can be reversed. Verification always recomputes forward from disclosed evidence.
- Payment alone never grants access to confidential evidence. Supplier authorisation and a valid Verifier entitlement are both required.
- A one-time purchase covers a Supplier-authorised event type and selected UTC range. Future events outside that range require a new purchase.
- A live subscription covers one Supplier-authorised event type, starts with the preceding 30 days, follows new events for a 28-day access term, and renews every 28 days.
- Verifier evidence is web-only: no download or export control is presented. This reduces casual leakage but cannot technically prevent screenshots, copying, recording, or extraction after browser disclosure.
- Outdock stores no Supplier original by default. Optional client-encrypted evidence storage includes the first 100 MB of active ciphertext per Supplier organisation; each additional started 100 MB costs USD 10 per 30-day Supplier billing period.
- Base is the recommended first production anchor network; the proof format remains network-agnostic.
- The four hard-coded Supplier plans are not an approved commercial decision and must not be carried into the upgrade unchanged.

## 2. Product promise

OD is a controlled evidence-integrity and disclosure network. It helps a Supplier prove that exact evidence was captured, ordered, preserved, and later disclosed without silent substitution. It helps an authorised Verifier independently recompute the proof and see its limits.

OD proves:

- the disclosed bytes produce content hash `H`;
- the canonical evidence manifest and salt produce commitment `C`;
- `C` is bound to an OD-signed receipt and append-only event proof;
- the event proof is included in an anchored batch; and
- the disclosed scope and access history are consistent with recorded authorisation.

OD does not independently prove that a statement, medical record, machine sensor, signature, employment assertion, or escrow document is truthful. Source identity, device signatures, completeness, gaps, and external corroboration remain visible parts of the assessment.

## 3. Canonical domain model

The product must stop overloading “event,” “type,” “case,” and “delivery.” The canonical hierarchy is:

```text
Supplier organisation
  -> Category
  -> Procedure definition
  -> Immutable procedure version
  -> Procedure instance
  -> Event definition / step
  -> Evidence event occurrence
  -> Evidence object(s)
  -> Receipt and anchor proof
  -> Evidence scope
  -> Supplier grant
  -> Verifier entitlement
```

### 3.1 Supplier organisation

The tenant that produces evidence. Examples: John and Johnson Logistics, a hospital, an escrow company, or an employer. Human members, API credentials, devices, and sources belong to the organisation.

### 3.2 Category

A Supplier-defined business classification, not a workflow step. Examples:

- `FOOD_DELIVERY`, `INGREDIENT_DELIVERY`, `COOKWARE_DELIVERY`;
- `PATIENT_SAFETY_CHECK`, `MEDICATION_ADMINISTRATION`;
- `ESCROW_TRANSACTION`, `FUNDS_RELEASE`;
- `EMPLOYMENT_STATUS`, `DISCIPLINARY_PROCEDURE`.

A procedure instance may have one primary category and optional secondary categories. Category definitions are versioned and may be retired, never silently repurposed.

### 3.3 Procedure definition and version

A reusable description of a whole procedure. Examples: “Florence food delivery,” “hospital medication-cart incident review,” “cross-company escrow closing,” or “employee status change.”

Each published version freezes:

- its name and purpose;
- permitted categories;
- ordered or conditional steps;
- which steps are required, optional, repeatable, or terminal;
- evidence requirements per step;
- authorised actor/source types;
- allowed state transitions;
- gap and lateness rules; and
- the JSON Schema used to validate structured facts.

Existing instances remain bound to the version on which they started. Editing a published procedure creates a new version.

### 3.4 Procedure instance

One real execution of a procedure. Examples: delivery `JJ-20251212-000381`, claim `CLM-3912`, escrow `ESC-8821`, or employment case `EMP-CHANGE-447`.

The instance has a stable Supplier-scoped external reference, status derived from its events, start time, optional completion time, participants, and jurisdiction. It does not overwrite historical facts when its derived status changes.

### 3.5 Event definition and event occurrence

An event definition is a reusable step such as `ORDER_RECEIVED`, `TRAFFIC_DELAY_REPORTED`, `RECIPIENT_SIGNED`, `FUNDS_DEPOSITED`, or `EMPLOYMENT_TERMINATED`.

An event occurrence is one immutable claim that a step happened for one procedure instance. Every occurrence has its own event ID, sequence, commitment, receipt, proof, evidence objects, and anchor status.

Use two orderings where needed:

- `instance_sequence`: order within one delivery, claim, escrow, or employment procedure;
- `source_sequence`: continuous order emitted by a gateway, device, or integration.

OD’s cryptographic append position remains server-assigned. Client-supplied sequence numbers are business evidence and must be checked, not trusted as chain authority.

### 3.6 Evidence object

One exact content object associated with an event: string, JSON, PDF, image, audio, video, or arbitrary bytes. An event may have multiple evidence objects, such as an escrow agreement, bank confirmation, and recipient signature.

For each object:

```text
H = SHA-256(exact original bytes)
```

Text rules must define UTF-8 encoding and normalisation. JSON uses RFC 8785 canonicalisation. Files use exact bytes and are never silently transcoded before hashing.

### 3.7 Evidence manifest and commitment

The client builds an RFC 8785 canonical manifest containing stable, authenticated facts, including evidence-object hashes. Identity and authority fields come from authenticated OD context, not arbitrary request fields.

```text
M = SHA-256(RFC8785(manifest))
C = SHA-256("OD2|EVIDENCE|" || random_32_byte_salt || M)
```

The manifest distinguishes:

- Supplier-claimed `occurred_at`;
- source/device time;
- OD-assigned `received_at`;
- OD chain position; and
- independent anchor time.

The client encrypts the manifest and salt as a small **disclosure capsule** separate from the original. D1 may store that capsule ciphertext and recipient key envelopes even in Commitment Only mode; this does not store the Supplier's original text or file. The capsule lets an authorised Verifier recover the committed H and metadata, then compare them with an original supplied separately. `C` cannot be reversed into the manifest, salt, H, or original.

### 3.8 Event proof

The Durable Object assigns the chain position and previous proof:

```text
proof_n = SHA-256(
  "OD2|EVENT|" || chain_id || position || received_at || C || previous_proof
)
```

The first event has an empty previous proof. Corrections append new events and never mutate the corrected event.

## 4. Evidence storage and encryption

Outdock offers two explicit evidence modes. **Commitment Only is the default.** Optional encrypted storage is a paid convenience, not a prerequisite for creating or anchoring evidence.

### 4.1 Commitment Only — default

- Outdock stores C, receipt, event-chain proof, Merkle path, anchor reference, and the encrypted disclosure capsule containing H, canonical manifest, and random salt.
- Outdock stores no Supplier text value, original file, encrypted original, preview, or derivative in this mode.
- The Supplier retains the exact original and supplies it to the Verifier through an agreed external channel.
- The Verifier loads that original into the web UI; hashing and comparison happen locally in the browser.
- The UI must say plainly that C cannot be reversed into H or into the original and that Outdock cannot recover lost evidence.

### 4.2 Optional encrypted storage

- The Supplier client hashes the exact original before encryption.
- The client generates a random data-encryption key per evidence object.
- The original is encrypted client-side with authenticated encryption; plaintext never reaches the Worker or D1.
- R2 stores ciphertext only.
- D1 stores the object reference, integrity metadata, encryption envelope metadata, ownership, grants, receipts, and audit history.
- The chain stores only aggregate commitments.

This mode enables account-based browser disclosure without WhatsApp/email passcodes. The first 100 MB of active ciphertext per Supplier organisation is included. Each additional started 100 MB is USD 10 per 30-day Supplier billing period, measured on peak active stored bytes; deletion prevents the next period's charge but does not prorate the current period. Removing a download button is a deterrent, not a guarantee against copying after browser disclosure.

### 4.3 Key model

- Each evidence object has a random data-encryption key (`DEK`).
- The DEK is wrapped to the Supplier organisation key.
- A Supplier-approved scope key may wrap the DEKs of scope members.
- The scope key is wrapped separately to each named Verifier’s public encryption key.
- D1 stores public keys and wrapped key envelopes, never plaintext private keys.
- A Verifier’s browser decrypts locally. Verifier CRUD, payment, disclosure, and verification are web-only in this version.
- Payment changes entitlement state; it never manufactures an encryption grant.

The product must choose and document one recovery posture before implementation:

1. **Zero-knowledge:** OD cannot recover keys; stronger confidentiality, but Supplier approval/device access is required for new wrapping and lost keys may be unrecoverable.
2. **Managed recovery:** a protected key-management service can recover or rewrap keys; smoother enterprise recovery, but OD has greater trust and compliance responsibility.

The choice is a security and legal decision, not a hidden implementation detail.

## 5. Track-specific flows

### 5.1 Track H — UI and API

Track H is for human-controlled evidence regardless of whether the human uses OD’s UI or an API client.

UI flow:

1. Choose or start a procedure instance.
2. Select the next event definition or an allowed exceptional event.
3. Enter a text/JSON value or choose PDF, image, MP3, MP4, or another file in the online hashing field.
4. Review the five evidence questions: who, what, when, where, and how.
5. Choose Commitment Only or paid encrypted storage.
6. Hash and canonicalise locally; encrypt only when paid storage is selected; submit the commitment package.
7. Receive the signed receipt immediately.
8. See `receipt issued`, `anchor pending`, `submitted`, and `confirmed` as separate states.

API flow:

- Uses a human-service credential or authenticated human session with explicit Track H scopes.
- Supports case/procedure creation, event append, correction append, evidence-upload initiation/finalisation, and receipt retrieval.
- Requires an idempotency key for mutations.
- Never allows callers to choose authoritative identity, OD receipt time, chain position, or previous proof.
- Supports direct encrypted-object upload without turning the event into Track M.

### 5.2 Track M — API only for records

- Supplier UI shows API credentials, sources, usage, errors, gap warnings, and the organisation's read-only Track M history.
- The UI contains no create, edit, correct, retry-as-new, or delete controls for Track M event records.
- Machine record creation is available only through scoped API credentials.
- Sources may represent a fleet gateway, EHR integration, escrow platform, HRIS, robot, sensor, or other system.
- Device/source signatures, global source sequence, instance sequence, clock quality, and gap detection are first-class evidence.
- The system never treats absence of a record as proof of absence without a defined heartbeat/completeness policy.

## 6. Supplier procedure-builder education

The procedure builder teaches by separating three questions:

1. **What kind of work is this?** Choose or create a Category.
2. **What whole journey should be evidenced?** Create a Procedure.
3. **What facts can happen during that journey?** Define Events/steps.

The guided builder has five stages:

### Stage 1 — Name the outcome

Ask: “What must another person be able to reconstruct later?” Examples are a completed delivery, a medication check, released escrow funds, or a verified employment-status change.

### Stage 2 — Define categories

Choose the primary subject-matter category and optional subcategories. Explain that category is for classification and filtering, not chronological order.

### Stage 3 — Define the event chain

For each step, collect:

- stable code and human label;
- purpose;
- required/optional/repeatable/terminal status;
- permitted predecessors and successors;
- required evidence types;
- required structured fields;
- who or what may submit it;
- lateness and gap rules; and
- resulting derived procedure status.

### Stage 4 — Simulate edge cases

Run examples for missing steps, repeats, corrections, out-of-order events, canceled procedures, partial delivery, refused signature, delayed medical checks, disputed escrow release, and reinstated employment.

### Stage 5 — Publish an immutable version

Show a plain-language summary and sample timeline. Publishing freezes the version; changes create a new version. The UI displays which live instances remain on older versions.

Starter templates accelerate learning but never restrict Supplier-defined events:

- Logistics delivery;
- Healthcare safety check;
- Escrow transaction;
- Employment status procedure;
- Blank custom procedure.

## 7. Verifier access and verification flow

Confidential evidence is invitation-first:

1. Supplier authorises one named Verifier or organisation team for one event type and allowed time boundary.
2. Supplier selects a named Verifier account, verified organisation, or invited email.
3. Supplier chooses the authorised event type, organisation/team boundary, and whether snapshot or live access is permitted. There is no evidence download permission in this version.
4. The Verifier authenticates and accepts the invitation.
5. Payment occurs only for an already-authorised scope, unless the Supplier sponsors it.
6. OD activates the entitlement only when both grant and payment conditions are satisfied.
7. Outdock renders authorised records only in the web room. For Commitment Only, the Verifier supplies the externally received original locally; for paid storage, the browser receives a short-lived encrypted stream and decrypts locally.
8. The Verifier browser recomputes original -> H -> manifest -> C.
9. The client verifies the receipt, event chain, Merkle inclusion, and chain anchor.
10. Every view, reveal, comparison, payment, denial, grant, and revocation is audited. No evidence download or proof-bundle export is offered.

One-time access uses half-open UTC boundaries `[start_at, end_at)`. Chargeable units are `ceil((end_at - start_at) / 604800)` at USD 25 per started seven-day unit. Units 1–6 cost USD 25 each and units 7+ cost USD 12.50 each. Do **not** discount the whole order at unit 7: seven units would fall from USD 150 for six units to USD 87.50 and create a pricing cliff. The selected data range is fixed; the web room remains available for seven days after successful payment, independent of how wide the selected event-time range is.

Live access covers exactly one event type. At activation time `T`, the readable event-time interval begins at `T - 30 days`; new matching events remain readable while the entitlement is active. The term ends at `T + 28 days`, so the first paid term spans up to 58 days of event time. Renewal advances the trailing start and live end continuously. Price: USD 88 every 28 days.

Expiry stops new server retrieval but cannot erase anything a human has already seen, copied, photographed, or captured. Deterrence controls are organisation-bound seats, re-authentication, short-lived view tokens/keys, dynamic user/time watermarks, copy/print/download UI suppression, rate limits, anomaly detection, access logs, Supplier alerts, and contractual confidentiality. Court disclosure uses a separately logged legal-export process with authority and case reference.

## 8. Data placement

### 8.1 D1

Keep relational identity, policy, state, and proof indexes in D1:

- Supplier organisations, members, roles, sessions, and credentials;
- categories and category versions;
- procedure definitions and immutable versions;
- procedure step definitions and transition rules;
- procedure instances and derived status;
- immutable event occurrences and corrections;
- non-sensitive evidence indexes, optional R2 references, encrypted disclosure capsules, and capsule key envelopes;
- public encryption keys and wrapped key envelopes;
- scopes, immutable scope versions, members, invitations, grants, and entitlements;
- receipts and signing-key registry;
- anchor batches, leaves, attempts, confirmations, and chain registry;
- billing orders, provider events, usage counters, and access audit events.

Proposed additive tables for a new migration:

- `categories`
- `category_versions`
- `procedure_definitions`
- `procedure_versions`
- `procedure_steps`
- `procedure_transitions`
- `procedure_instances`
- `procedure_instance_categories`
- `evidence_objects`
- `encryption_public_keys`
- `evidence_key_envelopes`
- `scope_versions`
- `scope_invitations`
- `scope_grants`
- `scope_key_envelopes`
- `evidence_access_events`
- `anchor_networks`
- `verifier_products`
- `verifier_orders`
- `verifier_order_ranges`
- `verifier_subscriptions`
- `stripe_webhook_events`
- `storage_allowances`
- `storage_usage_ledger`

Existing `cases`, `sources`, `events`, `evidence_scopes`, `evidence_scope_members`, `entitlements`, receipts, and anchor tables are migrated or bridged; historical immutable evidence is never rewritten.

### 8.2 R2

Store binary material only when the Supplier elects paid storage, and store it encrypted:

- encrypted original evidence;
- optional encrypted previews/derivatives;
- no verifier export bundles.

Use object keys without usernames, patient names, delivery names, or other sensitive semantics. D1 holds the authorised mapping. Upload finalisation verifies ciphertext size, checksum, ownership, and expected object state.

### 8.3 Public chain

The chain adapter stores only:

- batch ID;
- Merkle root;
- batch manifest hash;
- leaf/event counts; and
- chain timestamp emitted by the transaction.

Never put plaintext, ciphertext, H, salt, usernames, business categories, file names, or confidential metadata on-chain.

Use **Base** as the first production adapter and Base Sepolia for the new test deployment. It preserves the existing Solidity/EVM implementation path, publishes L2 transaction data to Ethereum through the OP Stack, has standard Ethereum JSON-RPC support, and is operationally simpler for this small commitment-only contract than adopting Cairo/Starknet or a chain-specific ZK stack. Polygon PoS remains a migration source, not the new product default. Product terminology and storage remain `anchor_network`, never Base-specific. The receipt/proof format identifies network, chain ID, contract, transaction, block, and confirmation policy so another adapter can be added without rewriting evidence.

## 9. Anchoring and cutoff semantics

OD separates four times:

- `occurred_at`: Supplier/source claim;
- `received_at`: OD-controlled receipt time;
- `receipt_issued_at`: OD signature time;
- `anchored_at`: independent chain time.

Normal anchoring closes batches daily by default; a lower-cost Supplier policy may close three times per week. High-assurance paths use `Seal now`:

- normal traffic: time/leaf-count-triggered batches, split deterministically into sub-batches when the configured leaf ceiling is reached;
- scope purchase: create a priority micro-batch containing only the selected scope's currently unanchored event occurrences; already anchored leaves are never duplicated and unrelated Event B leaves stay in their normal batch;
- premium API: optional immediate sealing for a selected event or micro-batch.

Each event occurrence belongs to exactly one anchor leaf and one closed batch. A scope references those leaves; it does not rebuild historical Event A data. At a scope cutoff, membership is frozen using explicit event IDs and a recorded `received_at` cutoff. The Verifier UI never calls an unanchored record “on-chain verified.” It displays receipt issued, awaiting batch, submitted, confirmed, failed, and superseded separately.

## 10. Pricing upgrade

### 10.1 Supplier

Replace the unapproved four-plan assumption with one coherent Supplier subscription model shared by Track H and Track M. Track choice does not create a second charge.

Price components may include:

- included monthly accepted events;
- first 100 MB of optional encrypted evidence storage;
- included scheduled anchoring;
- API throughput and retention policy;
- encrypted storage overage at USD 10 per additional started 100 MB of peak active ciphertext per 30-day billing period;
- `Seal now` transactions; and
- enterprise controls such as organisation recovery, SSO, regional storage, legal hold, and audit export.

Exact allowances and prices remain a product decision and must not be hard-coded until approved. Stripe configuration is generated from approved products, not from legacy A/B/C/D constants.

### 10.2 Verifier

Offer two clear products:

1. **Range access:** one-time web access for one Supplier-authorised event type and selected `[start_at, end_at)` UTC range. Each started seven-day unit is USD 25; recommended marginal 50% discount begins at unit 7.
2. **Live access:** USD 88 every 28 days for one Supplier-authorised event type, beginning with the previous 30 days and including matching new events during the active term.

The Supplier may sponsor either product. Payment never makes a confidential scope discoverable or grants access without a Supplier grant. Use one Stripe Product, `Outdock Verifier Event Access`, with one reusable Price for live access (`USD 88`, `interval=day`, `interval_count=28`). Calculate the one-time range total server-side and create Checkout line-item `price_data` for that order against the same Product. Create and bind these later as `STRIPE_VERIFIER_ACCESS_PRODUCT_ID` and `STRIPE_VERIFIER_LIVE_28D_PRICE_ID`; never invent their IDs in code or documentation. Persist Checkout Session, Subscription, Invoice, PaymentIntent, Product and Price references plus webhook idempotency in D1. Download restrictions reduce casual leakage but cannot promise revocation after disclosure.

### 10.3 Anchoring

Scheduled batch anchoring is included in Supplier service. `Seal now` and immediate-event anchoring may be charged separately because they create direct network cost and operational urgency.

## 11. Interface plan

### 11.1 Information architecture

Supplier workspace:

```text
Overview
Procedures
Active instances
Evidence
Sources and API keys
Verifier access
Anchoring
Usage and billing
Organisation and security
```

Verifier workspace:

```text
Invitations
Authorised scopes
Evidence timeline
Verification details
Access history
Billing
```

The interface is light-mode only. It uses one stable shell, strong section dividers, restrained colour, and one dominant task per view. At 1280×800 (a common 13-inch laptop viewport), the Proof Ladder remains visible without forcing the event input below the fold. At iPad Air widths, the ladder becomes a collapsible right drawer. On a narrow unfolded Galaxy Z Flip-class viewport, navigation becomes a bottom bar, lists precede detail views, and the event/hash chain becomes a vertically connected sequence. Installability, manifest, service worker, icons, offline shell, update prompt, and safe retry queue make it a PWA; confidential evidence and keys are never cached by the service worker.

### 11.2 Signature interaction

The memorable product element is the **Proof Ladder**. Every event shows five stacked, independently understandable checks:

1. Original matches H;
2. manifest plus salt matches C;
3. OD receipt signature is valid;
4. event-chain linkage is valid;
5. batch inclusion and public-chain anchor are valid.

Each rung displays `verified`, `pending`, `not supplied`, or `failed`. It never collapses partial evidence into a single misleading green badge.

### 11.3 Procedure-builder UI

- Left: ordered and conditional event steps.
- Centre: selected step requirements and transition rules.
- Right: sample timeline and warnings.
- Header: version state (`Draft`, `Published v1`, `Retired`).
- Publish review: plain-language reconstruction of what a Verifier will see.

### 11.4 Evidence-capture UI

- Start from the active procedure instance, not a generic upload form.
- Show the expected next steps while allowing authorised exception events.
- Track H alone exposes the online hashing input: paste text/JSON or choose PDF, PNG/JPEG, MP3, MP4, or another file. Show byte size, MIME type, local H, manifest preview, C, and storage choice before submit.
- Show exact hashing rules and evidence mode before capture.
- Return the signed receipt immediately and show anchor progress asynchronously.
- Keep the chain-of-effect visual beside the form: Original (local only) -> H -> canonical manifest + salt -> C -> event proof -> Merkle leaf/root -> Base anchor.
- Track M has no event-input surface. It shows read-only accepted/rejected history, source sequence, gap warnings, receipt state, and anchor state generated by API activity.

### 11.5 Verifier UI

- Invitation page identifies the Supplier and scope before payment.
- Verifier CRUD is web-only: accept/decline invitation, choose the authorised event type and UTC range, select range or live access, pay through Stripe Checkout, manage team seats, and revoke sessions.
- Before checkout, show only non-confidential Supplier identity, event-type label, chosen bounds, number of seven-day units, discounts, access term, and total.
- Timeline groups events by procedure instance and preserves exact scope cutoff.
- Evidence viewer shows who, what, when, where, and how alongside the Proof Ladder. Commitment Only asks the Verifier to load the Supplier-provided original locally; paid storage reveals an authorised encrypted stream in-browser.
- No download/export action appears. Persistent watermark and session identity remain visible while confidential evidence is revealed.

## 12. API plan

Representative versioned surfaces:

```text
POST /api/v2/h/procedures
POST /api/v2/h/instances
POST /api/v2/h/instances/:instanceRef/events
POST /api/v2/h/events/:eventId/corrections

POST /api/v2/m/sources
POST /api/v2/m/records
POST /api/v2/m/records:batch

POST /api/v2/evidence/uploads
POST /api/v2/evidence/uploads/:uploadId/finalise

POST /api/v2/scopes
POST /api/v2/scopes/:scopeId/publish
POST /api/v2/scopes/:scopeId/invitations
POST /api/v2/invitations/:token/accept
POST /api/v2/scopes/:scopeId/seal

GET  /api/v2/verifier/scopes/:scopeId
GET  /api/v2/verifier/scopes/:scopeId/events
GET  /api/v2/verifier/events/:eventId/evidence
POST /api/v2/verify
```

All Supplier mutations require idempotency. Human and machine credentials have distinct scopes. Verifier endpoints are browser-session-only and are not issued general-purpose API keys. Confidential lookup endpoints require both an active Supplier grant and entitlement. API responses distinguish proof finality and never embed private keys.

## 13. Migration phases

### Phase A — Freeze the language and commercial decisions

- Approve canonical terms and the Track H/Track M boundary.
- Decide key recovery posture.
- Approve Supplier charging dimensions and Verifier range/live products.
- Approve normal anchor cadence and `Seal now` service level.

Exit criterion: glossary, pricing configuration, threat decisions, and API compatibility policy are signed off.

### Phase B — Add versioned procedures and categories

- Add category, procedure, version, step, transition, and instance tables.
- Bridge existing Track H cases and Track M delivery IDs to procedure instances.
- Add builder APIs and UI.
- Validate transitions while continuing to preserve every accepted event immutably.

Exit criterion: logistics, healthcare, escrow, and employment templates pass normal and edge-case simulations.

### Phase C — Add optional encrypted storage

- Keep Commitment Only as the default; add R2 binding and encrypted multipart upload only for Suppliers who elect storage.
- Add evidence objects, encryption identities, key envelopes, recovery policy, and deletion/retention state.
- Add Track H UI/API and Track M API support for optional encrypted originals without adding Track M UI writes.

Exit criterion: string, JSON, PDF, image, MP3, and MP4 round-trip without plaintext reaching Worker application storage or logs; altered ciphertext, evidence, manifest, salt, or key envelope fails verification.

### Phase D — Invitation-first Verifier rooms

- Add scope versions, invitations, grants, recipient-bound envelopes, and access audit.
- Gate checkout behind an approved invitation.
- Add range and live entitlements.
- Add Proof Ladder and evidence comparison UI/API.

Exit criterion: an uninvited payer cannot discover or decrypt evidence; a named Verifier can independently recompute the complete proof.

### Phase E — Base adapter and finality

- Replace Polygon-specific product names with an anchor adapter and network registry.
- Deploy the versioned commitment contract to Base Sepolia, verify bytecode/source, run proof fixtures, then deploy the approved build to Base mainnet.
- Implement scheduled close, `Seal now`, retry, replacement, confirmation, and reorganisation handling.
- Version proof packages so old anchors remain independently verifiable.

Exit criterion: pending and confirmed states are correct under delay, failure, duplicate scheduling, replacement, and chain reorganisation tests.

### Phase F — Billing and production migration

- Remove A/B/C/D assumptions from UI, D1 seeds, types, and Stripe environment requirements after pricing approval.
- Create approved Stripe products and webhook mappings.
- Backfill existing development data through explicit bridge records without rewriting immutable evidence.
- Run production migration, security review, browser/API journeys, and disaster-recovery drills.

Exit criterion: billing cannot create access without authorisation; expiry blocks new retrieval; no Verifier download/export control exists; authorised court export is a separately logged path.

## 14. Linear-ready backlog

Linear is not connected in this workspace. The following issues are ready to copy into Linear.

### Epic OD-100 — Domain foundation

- **OD-101: Canonical glossary and compatibility map** — document Category, Procedure, Version, Instance, Event Definition, Event Occurrence, Evidence Object, Scope, Grant, Entitlement, Receipt, and Anchor. Acceptance: every existing table/route maps to exactly one canonical concept or is marked deprecated.
- **OD-102: Procedure/category D1 migration** — create additive versioned tables and indexes. Acceptance: migration preserves all existing immutable event and receipt rows.
- **OD-103: Procedure validation service** — validate required, optional, repeatable, conditional, and terminal steps. Acceptance: invalid transitions return actionable errors without deleting or mutating evidence.
- **OD-104: Starter procedure templates** — logistics, healthcare, escrow, employment, and blank custom. Acceptance: each template includes edge-case simulations and versioning.

### Epic OD-200 — Commitment and optional encrypted storage

- **OD-201: Optional R2 encrypted evidence binding** — provision dev/prod ciphertext buckets with non-semantic object keys; never create objects in Commitment Only mode.
- **OD-202: Evidence-object D1 model** — persist hash, media type, byte count, encryption version, R2 state, and owner linkage.
- **OD-203: Client encryption package** — hash exact bytes, canonicalise manifest, generate DEK, encrypt, and wrap keys.
- **OD-204: Paid storage metering and upload** — include the first 100 MB of active ciphertext, meter peak active bytes in additional started 100 MB blocks at USD 10 per 30-day period, and support idempotent resumable upload.
- **OD-205: Commitment Only mode** — retain privacy-minimal flow with explicit unrecoverability warning.
- **OD-206: Key recovery decision and implementation** — implement only the approved zero-knowledge or managed-recovery posture.

### Epic OD-300 — Track H and Track M

- **OD-301: Track H v2 UI capture** — procedure-led evidence capture for strings and files.
- **OD-302: Track H v2 API credentials** — human-service scopes for programmatic Track H submission.
- **OD-303: Track M sealed record API** — machine-only record writes with evidence objects, source signatures, and dual sequence checks.
- **OD-304: Mode enforcement regression suite** — prove H UI/API works and M manual UI record creation remains impossible.
- **OD-305: Gap and clock-quality evidence** — surface missing heartbeat, out-of-order source records, and uncertain timestamps.

### Epic OD-400 — Verifier rooms

- **OD-401: Scope version and cutoff model** — immutable event membership for one-time ranges and explicit rolling rules for live scopes.
- **OD-402: Invitation and Supplier approval** — no confidential discovery or checkout without a grant.
- **OD-403: Recipient encryption identity** — register Verifier public keys and create recipient-bound scope envelopes.
- **OD-404: Web-only evidence room** — locally compare Supplier-provided originals or reveal authorised encrypted streams without download controls.
- **OD-405: Proof Ladder** — independently report evidence, commitment, receipt, chain, and public-anchor results.
- **OD-406: Disclosure controls and audit** — organisation seats, dynamic watermark, short-lived sessions/keys, rate limits, legal-export exception, and view/denial/grant/revocation audit.

### Epic OD-500 — Anchoring

- **OD-501: Anchor-network registry and adapter interface** — remove Polygon-specific assumptions from product/domain layers.
- **OD-502: Scheduled batch policy** — close by time and size with deterministic manifests.
- **OD-503: Scope priority micro-batch** — anchor only selected, currently unanchored scope leaves without duplicating prior leaves or pulling unrelated events forward.
- **OD-504: Confirmation and reorganisation state machine** — never report premature finality.
- **OD-505: Cross-network proof fixtures** — retain independent verification across adapter versions.

### Epic OD-600 — Billing

- **OD-601: Remove unapproved four-tier Supplier model** — replace legacy constants only after approved pricing configuration exists.
- **OD-602: Supplier subscription and metering** — one Supplier identity across H/M, with approved allowances and overage rules.
- **OD-603: Verifier range checkout** — invitation-gated UTC range access at USD 25 per started seven days with marginal half-price units from unit 7.
- **OD-604: Verifier live checkout** — USD 88 per 28 days for one event type, with a 30-day lookback and matching new events through the active term.
- **OD-605: Sponsored access** — allow Supplier-paid Verifier entitlement.
- **OD-606: Seal-now billing** — charge or include immediate anchoring according to approved policy.

### Epic OD-700 — Production assurance

- **OD-701: Threat model and privacy review** — key loss, malicious Supplier, guessing, replay, unauthorised payment, insider access, metadata leakage, browser disclosure limits, and court-export controls.
- **OD-702: End-to-end browser journeys** — Supplier builder, H UI/API, M API/read-only UI, invitation, range/live checkout, local compare, authorised reveal, and anchor.
- **OD-706: PWA and responsive shell** — light-only installable shell verified at 1280×800, iPad Air portrait/landscape, and narrow Galaxy Z Flip-class unfolded viewport; never cache confidential evidence or keys.
- **OD-703: High-volume and tenant-isolation tests** — prove indexes, batching, Durable Object partitioning, storage quotas, and tenant boundaries at target scale.
- **OD-704: Backup and recovery drill** — D1 metadata, R2 ciphertext, key registry, receipt keys, and proof reconstruction.
- **OD-705: Production migration and rollback runbook** — reversible application rollout without rewriting immutable evidence.

## 15. Acceptance journeys

The upgrade is not complete until these journeys pass through rendered UI and real APIs:

1. A logistics Supplier defines categories, publishes a delivery procedure, starts an instance, submits Track H events through UI and API, and submits machine events only through Track M API.
2. A hospital uses Commitment Only for a PDF and video, grants a named insurer, and the insurer recomputes both locally from separately supplied originals; an uninvited paid account cannot access metadata or proof.
3. An escrow company appends a corrected agreement without altering the first agreement and exports both versions with their chain relationship.
4. An employer defines a status-change procedure with suspension, reinstatement, and termination branches and retains the procedure version used by every instance.
5. A Verifier buys a selected UTC range, recomputes original -> H -> C in the web UI, verifies receipt/chain/Merkle/anchor, and sees all timing distinctions without a download action.
6. A live Verifier activated at `T` sees the selected event type from `T - 30 days` through new events before `T + 28 days`; a range buyer sees only the purchased half-open range.
7. A purchase containing unanchored Event A leaves triggers a priority micro-batch for those leaves only, remains visibly pending until confirmation, and never duplicates prior leaves or claims an earlier public-chain time.
8. A lost or altered original, manifest, salt, ciphertext, envelope, receipt, chain link, Merkle path, or anchor reference produces a specific failed rung in the Proof Ladder.

## 16. Decisions required before implementation

- Zero-knowledge key handling or managed recovery?
- Exact Supplier base price, included events/storage/egress, and overage policy?
- Who pays for Verifier access: Verifier, Supplier, or either?
- Normal anchor cadence, target confirmation policy, and `Seal now` price/SLA?
- Required Base confirmation policy and whether a later Ethereum L1 checkpoint is needed for court-grade packages?
- Required compliance posture and storage regions for healthcare, insurance, escrow, and employment evidence?
