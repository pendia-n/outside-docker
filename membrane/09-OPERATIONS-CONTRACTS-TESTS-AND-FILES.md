# Operations, contracts, tests, and repository inventory

## Build and runtime stack

- Node/ES modules with pnpm lockfile.
- Hono `4.13.x`, ethers `6.17.x`, QR code generation, TypeScript 7, Vite 8, Cloudflare Vite plugin, Wrangler 4, solc 0.8.36.
- `pnpm run check` runs typecheck, all Node tests, contract compilation, and Worker/client build.
- Build sanitation removes generated `dist/outside_docker_sol_app/.dev.vars` so local secrets are not left in the deployment bundle.
- Vite dev/preview bind only to `127.0.0.1`; inspector is disabled.

## Current Cloudflare configuration

- Worker name: `outside-docker-sol-app`.
- Compatibility date: `2026-08-15`; `nodejs_compat` enabled.
- Observability enabled.
- Durable Object binding: `CHAIN_COORDINATOR`, class `ChainCoordinator`, SQLite class migration tag `v1`.
- D1 bindings: `outside-docker-dev` and `outside-docker-prod`.
- Cron: once daily at 01:17 UTC.
- Committed `ENV`: `dev`.
- Maximum application request body by declared Content-Length: 15 MB.

## Configuration inventory

### Required for authentication

- `JWT_SECRET`: at least 32 bytes; session signing plus independently derived TOTP/recovery protection.
- `CSRF_SECRET`: optional; falls back to JWT secret, though independent value is preferable.
- `APP_ORIGIN`: strongly required in prod and must be HTTPS; request origin is fallback outside that condition.

### Required for signed receipts

- `RECEIPT_PRIVATE_KEY_JWK`
- `RECEIPT_PUBLIC_KEY_JWK`
- `RECEIPT_KEY_ID`

Private/public Ed25519 keys must match. There are no TOTP-specific Worker secrets.

### Current verifier purchase Stripe configuration

- `STRIPE_API_KEY`
- `STRIPE_WEBHOOK_SECRET` (comma-separated rotation secrets supported)
- `STRIPE_PRICE_VERIFIER_7D`
- `STRIPE_PRICE_VERIFIER_SUBSCRIPTION_28D`

The 7+ unit one-time discount is generated dynamically; no discounted Price ID exists.

### Supplier/legacy Stripe configuration still read by code

- `STRIPE_PRICE_PLAN_A`
- `STRIPE_PRICE_PLAN_B`
- `STRIPE_PRICE_PLAN_C`
- `STRIPE_PRICE_PLAN_D`
- `STRIPE_PRICE_READ_PASS` (legacy $29 scope pass)

The current register route does not reach the supplier/legacy account Checkout function, so these are code-read configuration for incomplete/unwired flows rather than proof of live signup billing.

### Blockchain configuration

- Dev: `POLYGON_RPC_URL`, `POLYGON_PRIVATE_KEY`, `POLYGON_CONTRACT_ADDRESS_DEV`, chain ID stored in `BASE_CHAIN_ID_DEV=80002`.
- Prod: `BASE_RPC_URL`, `BASE_PRIVATE_KEY`, `BASE_CONTRACT_ADDRESS_PROD`, `BASE_CHAIN_ID_PROD=8453`.
- Shared: `BASE_CONFIRMATIONS`, `OUTDOCK_ANCHOR_PROTOCOL_ID`.

`BASE_CONTRACT_ADDRESS_DEV` remains declared/committed empty and is not used by current dev routing.

The ignored root `.env` currently uses the local names `BASE_RPC` and `BASE_PRIVATE`, while runtime/deployment code expects `BASE_RPC_URL` and `BASE_PRIVATE_KEY`. Base deployment therefore requires explicitly mapping/exporting those names; the Base deploy script does not automatically load root `.env`. The Amoy script does automatically load it and its Polygon names already match.

The ignored `sol-app/.dev.vars` still contains four obsolete `TOTP_*` names. Current source never reads them. `.dev.vars.example` no longer requires them and documents Polygon values only as comments, but it does not enumerate Base or Stripe settings.

## Contract files and deployments

`contracts/src/OutDock.sol` is the active version-2 contract. `ODAnchor.sol` is the older owner-only contract. Build/deployment JSON files contain public ABI/bytecode/deployment metadata; they contain no private key.

- Polygon Amoy OutDock: `0x6415C7Bf281dA2312fc7Bc644f915eae6653A6D6`, chain 80002, transaction `0x3351bf2b2f610897a824af98ed56d2c5824cf34fd90761ad2ea672e6377d1a4c`, block 47151463.
- Base mainnet OutDock: `0x808671572b8090e39B14bc4f8e10Befd53738927`, chain 8453, transaction `0xbb7314b488f10ed54a12b32ca1908d9e60e5652496b4b5bef92a75edc5d2975e`, block 50961939.

The build artifact is named `OutDock.base-build.json` and advertises Base targets even though identical EVM bytecode is deployed to Polygon Amoy. The Amoy deploy script deliberately reuses it and verifies exact runtime bytecode.

## Deployment scripts

- `build-contract.mjs`: optimized runs=200 compilation of OutDock and deterministic ABI/bytecode/metadata artifact.
- `deploy-mainnet-contract.mjs`: Base 8453 preflight, gas affordability, optional dry run, 3 confirmations, runtime-code match, deployment record.
- `deploy-amoy-contract.mjs`: reads ignored root `.env`, enforces Amoy 80002, deploys owner/anchorer, 3 confirmations, runtime-code match, deployment record.
- `deploy-dev-contract.mjs`: legacy Base Sepolia/ODAnchor deploy path; it expects `BASE_RPC_URL`/`BASE_PRIVATE_KEY` names from root `.env` and is not exposed as a package script.
- `verify-contract.mjs`: submits Base mainnet standard JSON/compiler settings and constructor arguments to Etherscan V2 and polls verification.
- `sanitize-build.mjs`: removes copied local dev secrets from build output.
- `ts-resolver.mjs`: adds `.ts` resolution for Node's experimental test runner.

## Test coverage observed

There are 48 passing tests in the latest recorded full check. Suites cover:

- exact one-time whole-transaction discount and subscription window;
- Merkle determinism, odd leaves, and tamper failure;
- anchor material binding, protocol ID, configuration column order, stale submitted recovery, and dropped transaction retry;
- PBKDF2 legacy upgrade, strict environment-bound session verification, origin/CSRF binding;
- Stripe API version/metadata/idempotency, one-price discount construction, webhook signature/mode/idempotency, atomic supplier activation;
- canonical JSON stability/rejection;
- Durable Object chain ID binding, signed receipt idempotent replay, conflicting key, cross-chain D1 race, logical chain identity, atomic append persistence;
- PDF structure;
- receipt key-pair validation and key identity;
- Ed25519 canonical signing and tamper detection;
- D1 evidence immutability and published-scope/Merkle immutability;
- RFC 6238 TOTP, counter replay rejection, encrypted enrollment, keyed recovery hashes;
- Track H validation and retained-content rejection;
- Track M JSON equivalence, request/manifest determinism, ephemeral bytes, and path/URL rejection;
- registration validation;
- share-token hashing and registry-pinned receipt verification.

Not covered end to end by the tests are a real Cloudflare browser journey, real Stripe Checkout/webhook renewal, actual D1 migration against both remote databases in this documentation pass, paid-grant data leakage controls, large priority-range completion, or live chain anchoring from the scheduled Worker.

## Repository file classes

The audit enumerated 6,068 non-`.git` files. Project-authored files include root assets/docs, `sol-app/src`, migrations, contracts, scripts, public UI/PWA assets, package/config files, and tests.

Large non-authored/generated groups include:

- `sol-app/node_modules`: installed third-party packages;
- `sol-app/dist`: generated build output when present;
- `sol-app/worker-configuration.d.ts`: generated Cloudflare runtime types (over 7,000 lines, most unrelated to used bindings);
- `graphify-out`: generated code/document relationship graph and reports;
- `.playwright-cli`: prior browser capture/log artifacts;
- `.git`: repository history and object database;
- `.DS_Store`: macOS metadata.

The root `.env` and `sol-app/.dev.vars` are ignored secret-bearing local configuration. This documentation intentionally records variable names only, never values.

## Remaining README accuracy warning

`sol-app/README.md` is not authoritative and is currently stale: it mentions separate TOTP secrets, Polygon-only deployment variables, ODAnchor deployment, `/api/stripe/webhook`, and pay-before-prod registration. The active code uses JWT-derived TOTP protection, dev Amoy/prod Base OutDock routing, `/api/webhooks/stripe`, and immediate registration. It was not edited because this task only permits new Markdown inside `membrane` and deletion of root Markdown.
