# Outside Docker

Outside Docker is a Cloudflare Worker for preserving evidence integrity without retaining original files. It supports human case records (Track H), machine/gateway records (Track M), signed receipts, append-only event chains, scoped sharing, portable proof/PDF exports, and Polygon batch anchoring.

## Architecture

- Hono + server-rendered TSX pages, with a small browser client in `public/app.js`
- Cloudflare D1 for accounts, billing state, chains, events, receipts, scopes, shares, anchors, and usage
- a Durable Object per logical chain for serialized, race-free positions and previous-proof links
- canonical `OD-RECEIPT-1` receipts signed with a dedicated Ed25519 key
- Stripe Checkout and verified, idempotent raw-body webhooks for production entitlements
- local hashing/encryption for Track H; original files, passcodes, and proof capsules are never accepted by the Worker

The authoritative event proof is:

```text
SHA-256(UTF8("OD1|EVENT|<chain>|<position>|<received>|<commitment>|<previous-proof>"))
```

## Local development

```bash
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm exec wrangler d1 migrations apply outside-docker-sol --local
pnpm run dev
```

The development server is loopback-only and does not expose a debug inspector. Development registration activates test accounts immediately; production registration activates only after a verified Stripe webhook.

Run the full quality gate with:

```bash
pnpm run check
pnpm run build
```

`check` runs TypeScript validation plus the security, receipt, billing, chain, Merkle, anchoring, schema, Track H, Track M, and verifier suites.

## Configuration

Copy `.dev.vars.example` and provide independent secrets. Do not reuse the session secret for receipts, CSRF, TOTP, recovery codes, or Stripe.

Required production settings include:

- `JWT_SECRET` and `CSRF_SECRET` (at least 32 bytes each)
- `TOTP_ENCRYPTION_KEY`, `TOTP_KEY_ID`, `TOTP_RECOVERY_PEPPER`, and `TOTP_RECOVERY_KEY_ID`
- matching `RECEIPT_PRIVATE_KEY_JWK` / `RECEIPT_PUBLIC_KEY_JWK` Ed25519 keys plus `RECEIPT_KEY_ID`
- restricted `STRIPE_API_KEY`, webhook secret, and configured supplier/read-pass Price IDs
- `APP_ORIGIN` using HTTPS
- Polygon RPC URL, signer key, chain ID, contract address, and confirmations

The app proves the configured receipt key pair matches before registering or signing with it. Public proof verification resolves keys from the trusted D1 registry; an artifact cannot nominate its own trusted key.

## Main API surfaces

- `/api/register`, `/api/login`, `/api/session`, `/api/security/*` — accounts, sessions, CSRF, TOTP, recovery
- `/api/h/*` — supplier cases, human events, and corrections
- `/api/v1/*` — scoped Track M sources, records, batches, receipts, chains, and usage
- `/api/api-keys/*` — issue, rotate, list, and revoke gateway keys
- `/api/shares`, `/api/public/shares/*` — immutable evidence scopes and constrained public links
- `/api/verify-proof`, `/api/receipt-public-key` — trusted portable verification and public receipt key
- `/api/stripe/webhook`, `/api/billing/portal` — billing lifecycle and customer portal

Machine writes require an `Idempotency-Key`. Replaying the same request returns the byte-identical response; reusing the key with a different request returns `409`.

## Production checklist

1. Apply all D1 migrations and configure the Durable Object binding.
2. Deploy the current `ODAnchor.sol`; the contract now rejects verification for nonexistent anchor IDs. Update `POLYGON_CONTRACT_ADDRESS` to that deployment.
3. Configure Stripe webhook delivery to `/api/stripe/webhook` and grant the restricted key only the Checkout, Subscription-read, and optional Billing Portal permissions used by the app.
4. Publish the receipt public key endpoint and retain retired verification keys in the registry.
5. Run `pnpm run check`, `pnpm run build`, and staging browser/API journeys before production traffic.

The system proves integrity, sequence, and anchoring. It does not prove that the underlying content was truthful.
