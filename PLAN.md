# Outside Docker MVP Implementation Plan

> **For Hermes:** Execute this plan sequentially. Do not delegate, deploy to mainnet, or modify `od.md` / `design.md` unless the user explicitly authorizes it.

**Goal:** Build a deployable OD vertical slice in one focused day: submit human or machine records, create an ordered hash chain, encrypt private payloads, anchor chain checkpoints to Polygon Amoy, and verify proofs without exposing private content.

**Architecture:** One Hono Worker backed by D1. Both Track H and Track M use one append service and one cryptographic format. D1 stores encrypted payloads and proof metadata; Polygon stores only a Merkle root representing chain checkpoints. The first deployment is development-only and uses synthetic data.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1, Web Crypto, Vitest, Polygon Amoy, Solidity/Foundry, React/Vite only after the API slice works.

---

## 1. Why this PLAN.md is necessary

`od.md` and `design.md` contain enough material to build the product, but they currently disagree on several implementation-critical decisions. Coding directly from both documents would produce incompatible auth, billing, verification, storage, and API behavior.

Until those documents are synchronized, this file is the canonical implementation contract.

### Locked decisions for the MVP

1. **Testnet first:** Polygon Amoy only. No mainnet deployment during the MVP build.
2. **No real customer evidence:** The first deployment accepts synthetic test data only.
3. **Free verification:** A judge, opposing counsel, or auditor must not pay or create an account merely to verify a proof.
4. **Private details remain protected:** Public verification shows proof status, receipt time, chain position/checkpoint, Merkle status, and transaction data—not decrypted payload content.
5. **Write credentials cannot read:** API keys may call `POST /event` and `POST /record`; sensitive reads require a later authenticated dashboard/share flow.
6. **No payloads on Polygon:** Polygon receives only an immutable Merkle root and batch metadata. It is not used as a permanent encrypted-document warehouse.
7. **One canonical serialization:** All payload hashing uses RFC 8785/JCS-compatible canonical JSON. Raw `JSON.stringify()` is not a proof format.
8. **Strong chain secret:** Do not use an 8-character passcode. Generate a 256-bit base64url chain secret and display it once.
9. **Stable key derivation:** Derive the per-chain encryption key with HKDF-SHA-256 from the chain secret and a stored random chain salt. Never generate a new unrecorded KDF salt on every write.
10. **Per-event encryption nonce:** Every encrypted event uses a unique random 96-bit AES-GCM nonce stored beside the ciphertext.
11. **Concurrent writes are protected:** Enforce `UNIQUE(chain_id, chain_position)` plus optimistic retry and idempotency keys. A concurrent append must never fork a chain silently.
12. **Precise legal claim:** OD proves that it received a particular record representation no later than an anchored checkpoint and that subsequent modification is detectable. It does not prove the underlying event was truthful or occurred at the submitted time.
13. **Secrets stay secret:** RPC credentials, wallet private keys, JWT secrets, and Stripe keys must use `wrangler secret put`; never place them under `[vars]` or commit them.
14. **No Stripe in the first-day slice:** Billing is deferred until technical and customer validation. When added, production uses the approved live-key configuration through Wrangler secrets.
15. **No production seed endpoint:** Local/dev fixtures are created through migration or a local script, never through a remotely reachable `__dev/seed` route.

---

## 2. Conflicts resolved by this plan

- `od.md` describes free signup and API-key reads; `design.md` describes paid signup, username/password sessions, TOTP, and write-only API keys. **MVP decision:** seeded development tenant + write-only API key. Full account auth comes later.
- `od.md` simultaneously defines a public verification route and says there is no public verification portal. **MVP decision:** public proof verification is free; private content requires an authorized share flow.
- `od.md` defines four database tables; `design.md` defines six materially different tables. **MVP decision:** use the schema in this plan.
- `od.md` mixes writer tiers, a $29 Read Pass, $0.01 events, Customer Balance, and monthly auto-debit. **MVP decision:** no billing in the technical slice; validate pricing separately.
- `design.md` proposes putting encrypted `display_blob` values permanently on Polygon. **MVP decision:** anchor roots only to avoid permanent ciphertext exposure, excessive gas, and deletion/privacy conflicts.
- `design.md` derives keys with a new random salt but does not store that salt, making later decryption impossible. **MVP decision:** one stored random `chain_salt` per chain plus HKDF.
- Both documents rely on `JSON.stringify()` without defining canonical field ordering. **MVP decision:** canonical JSON is mandatory for every proof.
- `cases.case_ref UNIQUE` is global in the documents. **MVP decision:** references are tenant-scoped; database uniqueness is `(tenant_id, kind, external_ref)`.
- The documents do not safely resolve two simultaneous appends. **MVP decision:** unique chain position, idempotency keys, atomic D1 batch, conflict retry.
- The phrase “prove an event happened at that time” overstates the system. **MVP decision:** use “prove this record was received by OD and anchored by this time.”

---

## 3. Day-one acceptance criteria

The day-one vertical slice is complete only when all of the following are true:

- `POST /event` appends three synthetic Track H events to one chain.
- `POST /record` appends three synthetic Track M records to one chain.
- Repeating a request with the same idempotency key returns the original result without creating a duplicate.
- Concurrent append tests cannot create duplicate positions or forks.
- D1 contains ciphertext, nonce, proof, previous proof, and metadata required for verification; it does not contain the plaintext payload.
- Changing one payload/ciphertext/proof causes verification to fail.
- Deleting or reordering an event conflicts with the anchored chain checkpoint.
- A Merkle root is submitted to an ODAnchor contract on Polygon Amoy.
- `GET /verify/public/:proof` confirms the local chain proof, checkpoint proof, and Amoy transaction without revealing the payload.
- All unit and integration tests pass.
- The Worker is deployed to a development `workers.dev` URL and smoke-tested with synthetic data.
- No mainnet funds, production wallet, live evidence, or customer payment is involved.

---

## 4. Accounts and external prerequisites

### Required for the first-day slice

- **Cloudflare account:** Workers + D1.
- **Polygon Amoy RPC provider:** Alchemy, QuickNode, or another Amoy-compatible RPC endpoint.
- **Dedicated testnet wallet:** A new wallet used only for Amoy—not a personal or treasury wallet.
- **Amoy test POL:** Obtain from an available Polygon/Alchemy/QuickNode faucet after the wallet is created.
- **Foundry:** Local Solidity compiler/test/deployment CLI.
- **Node.js:** Current LTS release.

### Deferred until after validation

- Stripe payment configuration.
- Custom production domain.
- Cloudflare Browser Rendering for PDF generation.
- R2 archival and backup automation.
- Transactional email provider.
- Production monitoring/alerting provider.
- Mainnet POL and a production deployer wallet.

### Secret setup

The user enters secrets locally; secrets are never pasted into chat or committed.

```bash
npx wrangler secret put POLYGON_RPC_URL --env development
npx wrangler secret put POLYGON_PRIVATE_KEY --env development
npx wrangler secret put POLYGON_CONTRACT_ADDRESS --env development
npx wrangler secret put API_KEY_PEPPER --env development
```

Non-secret values such as `CHAIN_ID=80002` and `APP_ENV=development` may remain in Wrangler environment variables.

---

## 5. Target file structure

```text
outside-docker/
├── PLAN.md
├── package.json
├── tsconfig.json
├── wrangler.toml
├── vitest.config.ts
├── migrations/
│   └── 0001_initial.sql
├── src/
│   ├── index.ts
│   ├── env.ts
│   ├── db.ts
│   ├── middleware/
│   │   └── api-key.ts
│   ├── lib/
│   │   ├── bytes.ts
│   │   ├── canonical.ts
│   │   ├── crypto.ts
│   │   ├── chain.ts
│   │   └── merkle.ts
│   ├── services/
│   │   ├── append-event.ts
│   │   ├── verify-event.ts
│   │   └── anchor-batch.ts
│   └── routes/
│       ├── event.ts
│       ├── record.ts
│       ├── chain.ts
│       ├── verify.ts
│       └── anchor.ts
├── tests/
│   ├── canonical.test.ts
│   ├── crypto.test.ts
│   ├── chain.test.ts
│   ├── merkle.test.ts
│   ├── event-api.test.ts
│   ├── record-api.test.ts
│   ├── concurrency.test.ts
│   └── verify-api.test.ts
├── scripts/
│   ├── create-dev-tenant.ts
│   └── smoke-amoy.ts
└── contracts/
    ├── foundry.toml
    ├── src/ODAnchor.sol
    ├── test/ODAnchor.t.sol
    └── script/Deploy.s.sol
```

---

## 6. Canonical database schema

The first migration creates five tables.

### `tenants`

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `created_at TEXT NOT NULL`

### `api_keys`

- `id TEXT PRIMARY KEY`
- `tenant_id TEXT NOT NULL REFERENCES tenants(id)`
- `key_hash TEXT NOT NULL UNIQUE`
- `label TEXT NOT NULL`
- `machine_only INTEGER NOT NULL DEFAULT 0`
- `is_active INTEGER NOT NULL DEFAULT 1`
- `created_at TEXT NOT NULL`

### `chains`

- `id TEXT PRIMARY KEY`
- `tenant_id TEXT NOT NULL REFERENCES tenants(id)`
- `kind TEXT NOT NULL CHECK(kind IN ('human','machine'))`
- `external_ref TEXT NOT NULL` — synthetic/opaque identifier only; no PII
- `chain_salt TEXT NOT NULL`
- `head_proof TEXT`
- `event_count INTEGER NOT NULL DEFAULT 0`
- `latest_checkpoint_id TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `UNIQUE(tenant_id, kind, external_ref)`

### `events`

- `id TEXT PRIMARY KEY`
- `tenant_id TEXT NOT NULL REFERENCES tenants(id)`
- `chain_id TEXT NOT NULL REFERENCES chains(id)`
- `kind TEXT NOT NULL CHECK(kind IN ('human','machine'))`
- `idempotency_key TEXT NOT NULL`
- `ciphertext TEXT NOT NULL`
- `encryption_nonce TEXT NOT NULL`
- `payload_hash TEXT NOT NULL`
- `proof TEXT NOT NULL UNIQUE`
- `previous_proof TEXT`
- `chain_position INTEGER NOT NULL`
- `received_at TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `UNIQUE(chain_id, chain_position)`
- `UNIQUE(tenant_id, idempotency_key)`

### `anchor_batches`

- `id TEXT PRIMARY KEY`
- `merkle_root TEXT NOT NULL UNIQUE`
- `leaf_count INTEGER NOT NULL`
- `network TEXT NOT NULL`
- `chain_id INTEGER NOT NULL`
- `tx_hash TEXT`
- `block_number INTEGER`
- `status TEXT NOT NULL CHECK(status IN ('pending','submitted','confirmed','failed'))`
- `submitted_at TEXT`
- `confirmed_at TEXT`
- `created_at TEXT NOT NULL`

A checkpoint leaf is the canonical hash of:

```json
{
  "domain": "outside-docker/checkpoint/v1",
  "chain_id": "<opaque OD chain UUID>",
  "head_proof": "<latest event proof>",
  "event_count": 3
}
```

This commits both the head and expected length, allowing deletion/reordering claims to be evaluated against a known checkpoint.

---

## 7. Day-one tasks — strict sequence

### Task 1: Scaffold the Worker and test runner

**Files:** Create `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `src/index.ts`, `src/env.ts`.

1. Configure Hono, Vitest, Wrangler, TypeScript, and the D1 development binding.
2. Write a failing health-route test.
3. Run the specific test and confirm it fails because the app does not expose `/health`.
4. Implement `GET /health` returning `{ "ok": true, "environment": "development" }`.
5. Run the specific test, then the full suite.

Verification:

```bash
npm test
npm run typecheck
```

Expected: all tests pass and TypeScript reports no errors.

### Task 2: Implement canonical JSON and byte framing

**Files:** Create `src/lib/canonical.ts`, `src/lib/bytes.ts`, `tests/canonical.test.ts`.

1. Write tests proving differently ordered equivalent objects produce identical canonical bytes.
2. Write tests for Unicode, numbers, arrays, nested objects, and rejected non-JSON values.
3. Verify RED.
4. Implement JCS-compatible canonicalization using a maintained package or a fully tested local implementation.
5. Add explicit length-prefix framing for proof inputs; never concatenate ambiguous strings.
6. Verify GREEN and run the full suite.

### Task 3: Implement encryption and hashing primitives

**Files:** Create `src/lib/crypto.ts`, `tests/crypto.test.ts`.

1. Test SHA-256 against known vectors.
2. Test HKDF determinism with a stable chain salt.
3. Test that different chain salts create different keys.
4. Test AES-256-GCM round-trip.
5. Test that ciphertext or associated-data tampering fails authentication.
6. Implement with Web Crypto APIs.
7. Bind AES-GCM associated data to protocol version, tenant ID, chain ID, and event position.
8. Run all tests.

### Task 4: Implement domain-separated hash-chain proofs

**Files:** Create `src/lib/chain.ts`, `tests/chain.test.ts`.

Proof input must include:

- domain: `outside-docker/event/v1`
- chain UUID
- chain position
- server receipt timestamp
- payload hash
- previous proof or a fixed genesis marker

1. Write genesis and subsequent-event test vectors.
2. Test payload mutation, position mutation, timestamp mutation, previous-proof mutation, deletion, and reorder detection.
3. Verify RED.
4. Implement minimal proof generation and verification.
5. Verify GREEN.

### Task 5: Create and apply the D1 migration

**Files:** Create `migrations/0001_initial.sql`, `src/db.ts`, and database integration tests.

1. Write a failing migration/schema test.
2. Implement the five-table schema from §6.
3. Add all foreign keys and unique constraints.
4. Apply locally:

```bash
npx wrangler d1 migrations apply OD_DB --local
```

5. Verify duplicate idempotency keys and duplicate chain positions are rejected.

### Task 6: Add development API-key authentication

**Files:** Create `src/middleware/api-key.ts`, `scripts/create-dev-tenant.ts`, authentication tests.

1. Test missing, malformed, inactive, and valid API keys.
2. Hash raw API keys with SHA-256 plus `API_KEY_PEPPER`; store only the hash.
3. Generate a synthetic development tenant and one human/machine API key through the local script.
4. Do not create a remotely accessible seed route.
5. Confirm valid credentials can write but cannot access future private-read routes.

### Task 7: Implement the shared append service

**Files:** Create `src/services/append-event.ts`, `tests/concurrency.test.ts`.

1. Test first append, subsequent append, idempotent replay, and chain isolation.
2. Test simultaneous appends to the same chain.
3. Encrypt canonical payload bytes before D1 storage.
4. Use an atomic D1 batch with `UNIQUE(chain_id, chain_position)` and retry on a position conflict.
5. Update `chains.head_proof` and `event_count` in the same successful batch.
6. Return a receipt containing proof, previous proof, position, and `received_at`.
7. Never return or log the chain secret.

### Task 8: Expose Track H and Track M write routes

**Files:** Create `src/routes/event.ts`, `src/routes/record.ts`, API tests.

- `POST /event`: requires `external_ref`, `event_type`, optional precomputed `file_hash`, metadata, chain secret, and `Idempotency-Key`.
- `POST /record`: requires `external_ref`, `action`, params, metadata, chain secret, and `Idempotency-Key`.
- Track M requires a `machine_only` API key.
- Both routes call the same append service.
- Reject oversized payloads, missing secrets, PII-looking test fixtures in development docs, and invalid hashes.

Verification:

```bash
npm test -- event-api.test.ts record-api.test.ts concurrency.test.ts
```

### Task 9: Implement checkpoint Merkle trees

**Files:** Create `src/lib/merkle.ts`, `src/services/anchor-batch.ts`, `tests/merkle.test.ts`.

1. Define domain-separated leaf and node hashes.
2. Preserve left/right proof orientation.
3. Define deterministic behavior for an odd leaf count.
4. Test one, two, three, and many leaves.
5. Build one checkpoint leaf per changed chain using chain UUID, head proof, and event count.
6. Persist the root and local proof paths before submitting a transaction.

### Task 10: Build and test the root-only contract

**Files:** Create `contracts/src/ODAnchor.sol`, `contracts/test/ODAnchor.t.sol`, `contracts/script/Deploy.s.sol`, `contracts/foundry.toml`.

The contract stores/emits only:

- protocol version
- batch ID
- Merkle root
- leaf count
- block timestamp

It must not accept ciphertext, individual proofs, metadata, case references, or display blobs.

1. Test owner-only anchoring.
2. Test duplicate batch rejection.
3. Test root lookup by batch ID/root.
4. Run:

```bash
cd contracts && forge test -vvv
```

Expected: all contract tests pass.

### Task 11: Deploy the contract to Polygon Amoy

1. Create and fund a dedicated Amoy-only wallet with faucet POL.
2. Set the Amoy RPC URL and testnet private key locally.
3. Run a dry simulation before broadcasting.
4. Deploy using the script.
5. Record the Amoy contract address as a Wrangler development secret.
6. Verify the deployed bytecode and submit one synthetic root.
7. Do not deploy to Polygon mainnet.

### Task 12: Implement anchor submission and public verification

**Files:** Create `src/services/anchor-batch.ts`, `src/routes/anchor.ts`, `src/services/verify-event.ts`, `src/routes/verify.ts`, `tests/verify-api.test.ts`.

1. Protect manual development anchoring with an internal service secret; scheduled cron comes later.
2. Submit an unanchored batch root to the Amoy contract.
3. Persist transaction hash and confirmation status idempotently.
4. Implement `GET /verify/public/:proof`.
5. Return only non-sensitive proof/checkpoint/chain/network status.
6. Distinguish clearly between `pending`, `confirmed`, `invalid`, and `not_found`.
7. Never label an unconfirmed transaction as verified.

### Task 13: Deploy the development Worker and smoke-test

1. Apply the D1 migration to the development database.
2. Add required Wrangler development secrets.
3. Deploy the Worker to a development `workers.dev` route.
4. Run `scripts/smoke-amoy.ts` to:
   - create a human chain;
   - append three events;
   - create a machine chain;
   - append three records;
   - anchor checkpoints;
   - wait for confirmation;
   - verify every proof;
   - intentionally mutate a local fixture and confirm failure.
5. Save no customer or production data.

Final verification:

```bash
npm test
npm run typecheck
npm run build
cd contracts && forge test -vvv
node --run smoke:amoy
```

Expected: all checks pass, one Amoy transaction is confirmed, and the public endpoint exposes no private payload.

---

## 8. Post-day-one hardening sequence

### Phase A: Security and failure recovery

- Add request-size limits and structured redacted logging.
- Add API-key rate limiting and abuse controls.
- Add confirmation polling, dropped-transaction recovery, and idempotent fee replacement.
- Add D1 failure/retry tests and anchor reconciliation.
- Add a portable evidence bundle containing ciphertext, canonicalization/version metadata, proof path, checkpoint, and chain receipt.
- Design optional institutional key recovery; do not invent recovery cryptography without review.
- Obtain an independent cryptographic/security review before any real evidence is accepted.

### Phase B: Private share and dashboard authentication

- Choose one production auth model before coding it; do not mix API-key auth with JWT reads.
- Implement account creation, password reset/recovery, session revocation, CSRF protection, and optional TOTP.
- Implement expiring, hashed, use-limited share tokens.
- Keep chain secret delivery out-of-band.
- Build a minimal React dashboard: chains, event list, verification, API keys, and shares.

### Phase C: Customer-validation UI

- Add a printable verification page before PDF generation.
- Show plain-language statuses and exact claim boundaries.
- Build one Track H demo for a law-firm design partner.
- Do not build the full Track M dashboard until a robotics/AI design partner requests it.

### Phase D: Billing

- Validate who pays: evidence writer, organization, or verifier. The current Read Pass model is not assumed valid.
- Prefer organization-level B2B billing; keep public verification free.
- Make every payment webhook idempotent and every stored monetary unit explicit.
- Add billing only after at least one design partner confirms willingness to pay.

### Phase E: Reporting and operations

- Add chain-of-custody PDF only after the printable HTML report is accepted by a legal design partner.
- Add monitoring for error rate, failed anchors, delayed confirmations, and D1 failures.
- Use supported Cloudflare backup/time-travel or an external scheduled backup process; a Worker cron cannot execute the Wrangler CLI.
- Define retention and deletion policy with counsel before implementing irreversible storage claims.

---

## 9. Explicitly deferred from the MVP

- Polygon mainnet and Ethereum mainnet.
- Storing encrypted payloads or proofs on-chain.
- Stripe, Read Pass, Customer Balance, subscription tiers, or per-event charges.
- Full JWT/refresh-token/TOTP account system.
- Public access to decrypted event details.
- PDF/browser rendering.
- R2 archive and automated backups.
- MCP integration.
- SDK packages.
- EU AI Act marketing claims, ISO compliance claims, or claims that evidence is automatically admissible.
- Healthcare/PHI handling.
- Automatic institutional recovery or Shamir secret sharing.
- Multi-region/data-residency promises.

---

## 10. Mainnet gate

Mainnet deployment is prohibited until every item below is complete:

- The Amoy slice has run without proof divergence for at least seven days.
- Concurrency, idempotency, tampering, dropped-transaction, and replay tests pass.
- No private payload or identifying case/source reference is placed on-chain.
- A security reviewer approves canonicalization, key derivation, AES-GCM use, proof framing, Merkle construction, and contract behavior.
- A lawyer reviews product claims, Terms, privacy language, evidence-report wording, and retention policy.
- At least one design partner confirms the workflow solves a real problem.
- A production wallet, spending limit, key rotation process, and incident procedure exist.
- Monitoring and anchor reconciliation are operational.
- `od.md` and `design.md` are synchronized with the implemented behavior.

---

## 11. Time and effort

- **One focused day:** working synthetic-data vertical slice, automated tests, Amoy contract, development Worker, and public non-sensitive verification—assuming Cloudflare/RPC/wallet access is already available and no provider blocks deployment.
- **Two to four additional days:** hardening, private share flow, minimal dashboard, monitoring, and customer-demo quality.
- **Production legal-evidence service:** not determined by coding speed. Security review, legal review, operational controls, and customer validation are the actual gates.

The app is technically buildable quickly. The dangerous part is not code volume; it is making a cryptographic or legal claim that the implementation does not actually support.

---

## 12. Completion rule

Do not mark a task complete because code was generated. A task is complete only when its failing test was observed, the implementation passes that test, the full suite remains green, and the deployed behavior is independently smoke-tested with synthetic data.
