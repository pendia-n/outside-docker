# Current system architecture

## Runtime composition

Outdock is one Cloudflare Worker built with Hono, server-rendered TSX, a plain browser JavaScript client, Cloudflare D1, and one Durable Object class.

- `src/index.tsx` is the composition root. It mounts pages and APIs, installs response security headers, selects environment resources, handles Stripe webhooks, verifies proofs, and starts scheduled anchoring.
- `src/pages.tsx` renders the landing page, role-specific application shell, verification page, and Checkout status pages.
- `public/app.js` performs browser interactions and Track H local cryptography.
- `src/platform.ts` joins browser cookies, D1 account state, entitlements, origin checks, and CSRF checks.
- `src/chain-do.ts` serializes appends and persists events, receipts, and idempotency results atomically.
- `src/anchor.ts` builds Merkle batches and manages submission, confirmation, recovery, and retry state.
- D1 is the durable application record. The EVM contract stores only batch-level commitments.

## Main trust boundaries

1. **Supplier-controlled content boundary.** Track H reads a file or note in the browser. Original file bytes are not sent to the Worker. Track M may send a precomputed commitment/hash or ephemeral JSON, text, or base64 bytes; the Worker hashes ephemeral content and does not persist the original request content as an evidence object.
2. **Browser session boundary.** Browser users authenticate with an HttpOnly session cookie. Mutations require an origin check plus a session-bound double-submit CSRF token.
3. **Machine credential boundary.** Track M record writes use environment-bound bearer API keys with explicit scopes. Plaintext keys are returned only when issued or rotated.
4. **Chain-order boundary.** A Durable Object is named from canonical `{owner_id, track, external_ref}`. This gives each logical chain one serialized append lane.
5. **Receipt trust boundary.** The Worker signs canonical receipt JSON with Ed25519. Verification trusts a D1-registered key ID, not a public key supplied solely by an artifact.
6. **Blockchain boundary.** A scheduled Worker wallet sends batch commitments. Development uses Polygon Amoy; production uses Base mainnet.
7. **Payment boundary.** Access and legacy account-billing code call Stripe directly and fulfill only from a verified, idempotently claimed raw-body webhook.

## Request lifecycle

Every request receives an `X-Request-Id` derived from `CF-Ray` or a UUID. A declared body larger than 15,000,000 bytes is rejected before route handling. Responses receive `nosniff`, referrer, permissions, cross-origin isolation, CSP, and HTTPS HSTS headers. Production 5xx responses hide internal messages; development responses expose them.

The request selects `DB_DEV` when `ENV=dev` and `DB_PROD` when `ENV=prod`. There is no data sharing between those bindings. Session JWTs also contain and verify the environment, so a dev token cannot be accepted as a prod token.

## Development and production chain routing

| Runtime | Chain | Chain ID | Contract |
|---|---:|---:|---|
| `ENV=dev` | Polygon Amoy | `80002` | `0x6415C7Bf281dA2312fc7Bc644f915eae6653A6D6` |
| `ENV=prod` | Base mainnet | `8453` | `0x808671572b8090e39B14bc4f8e10Befd53738927` |

Development reads `POLYGON_RPC_URL`, signs with `POLYGON_PRIVATE_KEY`, and uses `POLYGON_CONTRACT_ADDRESS_DEV`. Production reads `BASE_RPC_URL`, signs with `BASE_PRIVATE_KEY`, and uses `BASE_CONTRACT_ADDRESS_PROD`. The variable name `BASE_CHAIN_ID_DEV` remains historically named but currently holds Polygon Amoy chain ID `80002`.

The committed Wrangler configuration currently sets `ENV` to `dev`, so the deployed Worker is presently wired to `DB_DEV` and Polygon Amoy. Merely having production bindings does not make that deployment production mode.

## Event-chain data flow

1. Track H or Track M produces a 64-character lowercase SHA-256 commitment and manifest hash.
2. The route authorizes the actor and requires an idempotency key.
3. The Durable Object instance for the owner/track/external reference receives the append.
4. It reads the current chain head, assigns `position`, captures `received_at`, and computes the event proof.
5. It constructs and signs an `OD-RECEIPT-1` receipt.
6. One D1 batch writes or advances the chain, inserts the event, inserts the receipt, inserts the completed idempotency response, and updates the case or source.
7. The caller receives the exact persisted result immediately with `pending_anchor`.
8. A later scheduled anchor batch creates Merkle membership data, sends one aggregate commitment to the active EVM contract, and projects confirmation state back onto events and receipts.

## Serialization and idempotency

The Durable Object prevents two simultaneous appends to the same logical chain from receiving the same position or previous proof. D1 additionally enforces credential/idempotency uniqueness across chains. An identical replay returns the stored response; the same key with a different request hash returns `409 idempotency_conflict`. Idempotency results for event writes carry a 90-day expiry timestamp, although no cleanup job is present in the inspected code.

## Scheduled anchoring

The committed cron is `17 1 * * *`, once daily at 01:17 UTC. Each run:

1. reconciles submitted batches older than 15 minutes;
2. processes the oldest pending priority request first;
3. otherwise selects the oldest unbatched pending events;
4. prepares at most 500 events in one batch;
5. submits up to ten due pending/retry batches sequentially;
6. waits for the configured confirmation count, currently 3;
7. retries failures with bounded exponential delay, up to 8 attempts;
8. marks terminal failures on batch, events, receipts, and linked priority request.

Only one new normal or priority batch is prepared per scheduled invocation. A priority range larger than 500 events therefore needs later scheduled runs to finish the remaining events; the priority request is attached to the first batch and becomes completed when that batch confirms.
