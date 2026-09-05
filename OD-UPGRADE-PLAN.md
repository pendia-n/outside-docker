# Outside Docker Upgrade Plan

## 1. Status and authority

This document is the proposed upgrade plan for Outside Docker after the September 2026 product review. It supersedes conflicting product assumptions in `SHOULD-BE.md`, `NOW-THAT.md`, `design.md`, and `od.md` for the scope described here. It is a plan, not a claim that these upgrades are implemented.

Decisions already established:

- Track H supports human evidence through both the web UI and an authenticated API.
- Track M accepts machine records only through scoped API credentials. Its web workspace is for configuration and read-only inspection, not manual machine-record creation.
- A Supplier may operate Track H, Track M, or both under one Supplier identity.
- OD must not pretend a commitment can be reversed. Verification always recomputes forward from disclosed evidence.
- Payment alone never grants access to confidential evidence. Supplier authorisation and a valid Verifier entitlement are both required.
- A published one-time scope is an immutable snapshot. Future events require a new scope or an explicitly live entitlement.
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

The salt and manifest must be retained inside the encrypted evidence package. `C` cannot be reversed into either one.

### 3.8 Event proof

The Durable Object assigns the chain position and previous proof:

```text
proof_n = SHA-256(
  "OD2|EVENT|" || chain_id || position || received_at || C || previous_proof
)
```

The first event has an empty previous proof. Corrections append new events and never mutate the corrected event.

## 4. Evidence storage and encryption

OD offers two explicit evidence modes.

### 4.1 Sealed Evidence — recommended default

- The Supplier client hashes the exact original before encryption.
- The client generates a random data-encryption key per evidence object.
- The original, manifest, H, salt, and disclosure metadata are encrypted client-side with authenticated encryption.
- R2 stores ciphertext only.
- D1 stores the object reference, integrity metadata, encryption envelope metadata, ownership, grants, receipts, and audit history.
- The chain stores only aggregate commitments.

This mode enables account-based disclosure without WhatsApp/email passcodes.

### 4.2 Commitment Only

- OD stores the commitment, manifest hash, receipt, chain proof, and anchor material.
- OD stores no original or encrypted original.
- The Supplier must retain and later provide the exact original, manifest, and salt.
- The UI and API must warn that OD cannot recover or disclose lost evidence.

### 4.3 Key model

- Each evidence object has a random data-encryption key (`DEK`).
- The DEK is wrapped to the Supplier organisation key.
- A Supplier-approved scope key may wrap the DEKs of scope members.
- The scope key is wrapped separately to each named Verifier’s public encryption key.
- D1 stores public keys and wrapped key envelopes, never plaintext private keys.
- A Verifier’s browser or API client decrypts locally.
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
3. Add structured facts and one or more evidence objects.
4. Review the five evidence questions: who, what, when, where, and how.
5. Choose Sealed Evidence or Commitment Only.
6. Hash, canonicalise, encrypt, and submit.
7. Receive the signed receipt immediately.
8. See `receipt issued`, `anchor pending`, `submitted`, and `confirmed` as separate states.

API flow:

- Uses a human-service credential or authenticated human session with explicit Track H scopes.
- Supports case/procedure creation, event append, correction append, evidence-upload initiation/finalisation, and receipt retrieval.
- Requires an idempotency key for mutations.
- Never allows callers to choose authoritative identity, OD receipt time, chain position, or previous proof.
- Supports direct encrypted-object upload without turning the event into Track M.

### 5.2 Track M — API only for records

- Supplier UI manages sources, keys, procedure definitions, categories, usage, and read-only history.
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

1. Supplier creates and publishes a scope with explicit event IDs and cutoff.
2. Supplier selects a named Verifier account, verified organisation, or invited email.
3. Supplier chooses view, export, expiry, and future-event permissions.
4. The Verifier authenticates and accepts the invitation.
5. Payment occurs only for an already-authorised scope, unless the Supplier sponsors it.
6. OD activates the entitlement only when both grant and payment conditions are satisfied.
7. OD returns ciphertext, wrapped keys, manifest, receipt, chain proof, Merkle path, and anchor reference.
8. The Verifier client decrypts locally and recomputes original -> H -> manifest -> C.
9. The client verifies the receipt, event chain, Merkle inclusion, and chain anchor.
10. Every view, proof retrieval, export, denial, grant, and revocation is audited.

A one-time scope remains a frozen snapshot. A live scope has explicit inclusion rules and a recurring entitlement. Expiry stops future retrieval but cannot erase evidence already decrypted or downloaded.

## 8. Data placement

### 8.1 D1

Keep relational identity, policy, state, and proof indexes in D1:

- Supplier organisations, members, roles, sessions, and credentials;
- categories and category versions;
- procedure definitions and immutable versions;
- procedure step definitions and transition rules;
- procedure instances and derived status;
- immutable event occurrences and corrections;
- evidence-object metadata and R2 references;
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

Existing `cases`, `sources`, `events`, `evidence_scopes`, `evidence_scope_members`, `entitlements`, receipts, and anchor tables are migrated or bridged; historical immutable evidence is never rewritten.

### 8.2 R2

Store only encrypted binary material:

- encrypted original evidence;
- encrypted manifest and disclosure payload;
- optional encrypted previews/derivatives;
- encrypted export bundles.

Use object keys without usernames, patient names, delivery names, or other sensitive semantics. D1 holds the authorised mapping. Upload finalisation verifies ciphertext size, checksum, ownership, and expected object state.

### 8.3 Public chain

The chain adapter stores only:

- batch ID;
- Merkle root;
- batch manifest hash;
- leaf/event counts; and
- chain timestamp emitted by the transaction.

Never put plaintext, ciphertext, H, salt, usernames, business categories, file names, or confidential metadata on-chain.

Polygon PoS may remain the first adapter, but product terminology and storage use `anchor_network`, not Polygon-specific names. Network selection evaluates cost, finality, explorer availability, decentralisation, operational reliability, and long-term verification. The receipt/proof format must identify the network, chain ID, contract, transaction, block, and confirmation policy.

## 9. Anchoring and cutoff semantics

OD separates four times:

- `occurred_at`: Supplier/source claim;
- `received_at`: OD-controlled receipt time;
- `receipt_issued_at`: OD signature time;
- `anchored_at`: independent chain time.

Normal anchoring uses scheduled batches. High-assurance paths use `Seal now`:

- normal traffic: time/size-triggered batches;
- scope publication or purchase: close and submit a batch containing eligible unanchored events;
- premium API: optional immediate sealing for a selected event or micro-batch.

At a scope cutoff, membership is frozen using explicit event IDs and a recorded `received_at` cutoff. The Verifier UI never calls an unanchored record “on-chain verified.” It displays anchored, submitted, pending, failed, and superseded states separately.

## 10. Pricing upgrade

### 10.1 Supplier

Replace the unapproved four-plan assumption with one coherent Supplier subscription model shared by Track H and Track M. Track choice does not create a second charge.

Price components may include:

- included monthly accepted events;
- included encrypted evidence storage and download;
- included scheduled anchoring;
- API throughput and retention policy;
- metered event/storage overage;
- `Seal now` transactions; and
- enterprise controls such as organisation recovery, SSO, regional storage, legal hold, and audit export.

Exact allowances and prices remain a product decision and must not be hard-coded until approved. Stripe configuration is generated from approved products, not from legacy A/B/C/D constants.

### 10.2 Verifier

Offer two clear products:

1. **Snapshot access:** one-time fee for one Supplier-authorised immutable scope, with a stated hosted-access window and permanent offline verification of lawfully downloaded proof.
2. **Live access:** recurring fee for an explicitly authorised evolving scope with future-event rules.

The Supplier may sponsor either product. Payment never makes a confidential scope discoverable or grants access without a Supplier grant. Download restrictions reduce casual leakage but cannot promise revocation after disclosure.

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
Exports
Access history
Billing
```

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
- Accept strings, JSON, PDFs, images, audio, video, and arbitrary files.
- Show exact hashing rules and evidence mode before capture.
- Return the signed receipt immediately and show anchor progress asynchronously.

### 11.5 Verifier UI

- Invitation page identifies the Supplier and scope before payment.
- Payment page never reveals confidential event details.
- Timeline groups events by procedure instance and preserves exact scope cutoff.
- Evidence viewer shows who, what, when, where, and how alongside the Proof Ladder.
- Export explains verification limits and distinguishes claimed, OD-observed, source-signed, and independently anchored facts.

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

All mutations require idempotency. Human and machine credentials have distinct scopes. Confidential lookup endpoints require both an active Supplier grant and entitlement. API responses distinguish proof finality and never embed private keys.

## 13. Migration phases

### Phase A — Freeze the language and commercial decisions

- Approve canonical terms and the Track H/Track M boundary.
- Decide key recovery posture.
- Approve Supplier charging dimensions and Verifier snapshot/live products.
- Approve normal anchor cadence and `Seal now` service level.

Exit criterion: glossary, pricing configuration, threat decisions, and API compatibility policy are signed off.

### Phase B — Add versioned procedures and categories

- Add category, procedure, version, step, transition, and instance tables.
- Bridge existing Track H cases and Track M delivery IDs to procedure instances.
- Add builder APIs and UI.
- Validate transitions while continuing to preserve every accepted event immutably.

Exit criterion: logistics, healthcare, escrow, and employment templates pass normal and edge-case simulations.

### Phase C — Add Sealed Evidence

- Add R2 binding and encrypted multipart upload flow.
- Add evidence objects, encryption identities, key envelopes, recovery policy, and deletion/retention state.
- Add Track H UI/API and Track M API support for encrypted originals.
- Preserve Commitment Only as an explicit alternative.

Exit criterion: string, JSON, PDF, image, MP3, and MP4 round-trip without plaintext reaching Worker application storage or logs; altered ciphertext, evidence, manifest, salt, or key envelope fails verification.

### Phase D — Invitation-first Verifier rooms

- Add scope versions, invitations, grants, recipient-bound envelopes, and access audit.
- Gate checkout behind an approved invitation.
- Add snapshot and live entitlements.
- Add Proof Ladder and evidence comparison UI/API.

Exit criterion: an uninvited payer cannot discover or decrypt evidence; a named Verifier can independently recompute the complete proof.

### Phase E — Chain abstraction and finality

- Replace Polygon-specific product names with an anchor adapter and network registry.
- Keep the current audited contract format as the first adapter where appropriate.
- Implement scheduled close, `Seal now`, retry, replacement, confirmation, and reorganisation handling.
- Version proof packages so old anchors remain independently verifiable.

Exit criterion: pending and confirmed states are correct under delay, failure, duplicate scheduling, replacement, and chain reorganisation tests.

### Phase F — Billing and production migration

- Remove A/B/C/D assumptions from UI, D1 seeds, types, and Stripe environment requirements after pricing approval.
- Create approved Stripe products and webhook mappings.
- Backfill existing development data through explicit bridge records without rewriting immutable evidence.
- Run production migration, security review, browser/API journeys, and disaster-recovery drills.

Exit criterion: billing cannot create access without authorisation; expired access blocks retrieval while downloaded proof remains verifiable.

## 14. Linear-ready backlog

Linear is not connected in this workspace. The following issues are ready to copy into Linear.

### Epic OD-100 — Domain foundation

- **OD-101: Canonical glossary and compatibility map** — document Category, Procedure, Version, Instance, Event Definition, Event Occurrence, Evidence Object, Scope, Grant, Entitlement, Receipt, and Anchor. Acceptance: every existing table/route maps to exactly one canonical concept or is marked deprecated.
- **OD-102: Procedure/category D1 migration** — create additive versioned tables and indexes. Acceptance: migration preserves all existing immutable event and receipt rows.
- **OD-103: Procedure validation service** — validate required, optional, repeatable, conditional, and terminal steps. Acceptance: invalid transitions return actionable errors without deleting or mutating evidence.
- **OD-104: Starter procedure templates** — logistics, healthcare, escrow, employment, and blank custom. Acceptance: each template includes edge-case simulations and versioning.

### Epic OD-200 — Sealed Evidence

- **OD-201: R2 encrypted evidence binding** — provision dev/prod ciphertext buckets with non-semantic object keys.
- **OD-202: Evidence-object D1 model** — persist hash, media type, byte count, encryption version, R2 state, and owner linkage.
- **OD-203: Client encryption package** — hash exact bytes, canonicalise manifest, generate DEK, encrypt, and wrap keys.
- **OD-204: Resumable upload/finalisation** — support large PDF/image/audio/video evidence with idempotent finalisation.
- **OD-205: Commitment Only mode** — retain privacy-minimal flow with explicit unrecoverability warning.
- **OD-206: Key recovery decision and implementation** — implement only the approved zero-knowledge or managed-recovery posture.

### Epic OD-300 — Track H and Track M

- **OD-301: Track H v2 UI capture** — procedure-led evidence capture for strings and files.
- **OD-302: Track H v2 API credentials** — human-service scopes for programmatic Track H submission.
- **OD-303: Track M sealed record API** — machine-only record writes with evidence objects, source signatures, and dual sequence checks.
- **OD-304: Mode enforcement regression suite** — prove H UI/API works and M manual UI record creation remains impossible.
- **OD-305: Gap and clock-quality evidence** — surface missing heartbeat, out-of-order source records, and uncertain timestamps.

### Epic OD-400 — Verifier rooms

- **OD-401: Scope version and cutoff model** — immutable event membership for snapshot scopes and explicit rules for live scopes.
- **OD-402: Invitation and Supplier approval** — no confidential discovery or checkout without a grant.
- **OD-403: Recipient encryption identity** — register Verifier public keys and create recipient-bound scope envelopes.
- **OD-404: Evidence room UI/API** — retrieve and locally decrypt authorised evidence.
- **OD-405: Proof Ladder** — independently report evidence, commitment, receipt, chain, and public-anchor results.
- **OD-406: Access audit and export policy** — record view, download, proof retrieval, denial, grant, and revocation.

### Epic OD-500 — Anchoring

- **OD-501: Anchor-network registry and adapter interface** — remove Polygon-specific assumptions from product/domain layers.
- **OD-502: Scheduled batch policy** — close by time and size with deterministic manifests.
- **OD-503: Seal now** — close a batch when an authorised scope requires immediate independent finality.
- **OD-504: Confirmation and reorganisation state machine** — never report premature finality.
- **OD-505: Cross-network proof fixtures** — retain independent verification across adapter versions.

### Epic OD-600 — Billing

- **OD-601: Remove unapproved four-tier Supplier model** — replace legacy constants only after approved pricing configuration exists.
- **OD-602: Supplier subscription and metering** — one Supplier identity across H/M, with approved allowances and overage rules.
- **OD-603: Verifier snapshot checkout** — invitation-gated one-time scope access.
- **OD-604: Verifier live checkout** — invitation-gated recurring access with future-event rules.
- **OD-605: Sponsored access** — allow Supplier-paid Verifier entitlement.
- **OD-606: Seal-now billing** — charge or include immediate anchoring according to approved policy.

### Epic OD-700 — Production assurance

- **OD-701: Threat model and privacy review** — key loss, malicious Supplier, guessing, replay, unauthorised payment, insider access, metadata leakage, and downloaded-data limits.
- **OD-702: End-to-end browser journeys** — Supplier builder, H UI/API, M API, invitation, checkout, decrypt, compare, anchor, export.
- **OD-703: High-volume and tenant-isolation tests** — prove indexes, batching, Durable Object partitioning, storage quotas, and tenant boundaries at target scale.
- **OD-704: Backup and recovery drill** — D1 metadata, R2 ciphertext, key registry, receipt keys, and proof reconstruction.
- **OD-705: Production migration and rollback runbook** — reversible application rollout without rewriting immutable evidence.

## 15. Acceptance journeys

The upgrade is not complete until these journeys pass through rendered UI and real APIs:

1. A logistics Supplier defines categories, publishes a delivery procedure, starts an instance, submits Track H events through UI and API, and submits machine events only through Track M API.
2. A hospital seals an encrypted PDF and video, grants a named insurer, and proves an uninvited paid account cannot access either object.
3. An escrow company appends a corrected agreement without altering the first agreement and exports both versions with their chain relationship.
4. An employer defines a status-change procedure with suspension, reinstatement, and termination branches and retains the procedure version used by every instance.
5. A Verifier receives a frozen scope, decrypts locally, recomputes original -> H -> C, verifies receipt/chain/Merkle/anchor, and sees all timing distinctions.
6. A live Verifier receives only future events permitted by the live-scope rule; a snapshot buyer receives none.
7. A scope published before the normal anchor window triggers `Seal now`, remains visibly pending until confirmation, and never claims an earlier public-chain time.
8. A lost or altered original, manifest, salt, ciphertext, envelope, receipt, chain link, Merkle path, or anchor reference produces a specific failed rung in the Proof Ladder.

## 16. Decisions required before implementation

- Zero-knowledge key handling or managed recovery?
- Is Sealed Evidence mandatory, default, or optional per procedure?
- Exact Supplier base price, included events/storage/egress, and overage policy?
- Exact one-time Verifier snapshot price and hosted-access window?
- Exact live Verifier subscription price and future-event rules?
- Who pays for Verifier access: Verifier, Supplier, or either?
- Normal anchor cadence, target confirmation policy, and `Seal now` price/SLA?
- Which chain/network is the first production anchor after cost, finality, availability, and explorer review?
- Required compliance posture and storage regions for healthcare, insurance, escrow, and employment evidence?

