# Source-file responsibility map

This map accounts for every project-authored file class inspected. Generated, dependency, secret, and OS files are separately identified at the end.

## Application source

| File | Current responsibility |
|---|---|
| `sol-app/src/index.tsx` | Worker composition, middleware, all top-level pages/routes, proof RPC verification, Stripe webhook, priority anchoring, schedule entrypoint, dev/prod chain routing |
| `sol-app/src/pages.tsx` | Landing, authenticated role/mode shell, Verifier purchasing, Supplier workspaces, verification and Checkout return pages |
| `sol-app/src/renderer.tsx` | Hono JSX renderer and common document head/assets |
| `sol-app/src/style.css` | Light-mode responsive design system and component/layout styling |
| `sol-app/src/types.ts` | Shared roles/modes/tracks/plans, environment bindings, plan limits, exported domain types |
| `sol-app/src/db.ts` | Environment D1 selection, query helpers, UUID/time helpers, safe seek cursors, unique-error detection |
| `sol-app/src/validation.ts` | Identity/password/email checks, JSON/value guards, encoding, constant-time compare, random bytes, SHA-256, error sanitization |
| `sol-app/src/canonical.ts` | Strict canonical JSON and canonical SHA-256 |
| `sol-app/src/auth.ts` | PBKDF2 passwords, strict session tokens, current-user/entitlement authorization, origin and CSRF controls |
| `sol-app/src/platform.ts` | Hono cookie/session/D1 adapter, active entitlements, Supplier mode and Verifier scope guards |
| `sol-app/src/account-routes.ts` | Registration/login/dashboard/TOTP/session routes plus currently unwired legacy production registration Checkout helper |
| `sol-app/src/totp.ts` | RFC-style TOTP, enrollment, AES-GCM envelopes, JWT-secret-derived keys, recovery codes |
| `sol-app/src/plans.ts` | Active Supplier plan lookup and atomic Track H rate consumption |
| `sol-app/src/event-catalog.ts` | Supplier event-type and event-instance service/routes |
| `sol-app/src/track-h.ts` | Cases, retained-content rejection, H event and correction append routes |
| `sol-app/src/track-m.ts` | Machine key/source/record/batch/read/usage services and routes; transient content hashing |
| `sol-app/src/chain-do.ts` | Domain append validation, event proof, Durable Object serialization, D1 atomic persistence and replay |
| `sol-app/src/receipts.ts` | Receipt schema validation, Ed25519 import/sign/verify, public key document |
| `sol-app/src/receipt-keys.ts` | Environment receipt-key loading, private/public match proof, D1 key registration |
| `sol-app/src/merkle.ts` | Domain-separated Merkle tree, path verification, leaf-index reconstruction, bytes32 conversion |
| `sol-app/src/anchor.ts` | Batch material, priority/normal selection, D1 state machine, on-chain submission/recovery/retry |
| `sol-app/src/verifier.ts` | Evidence scopes, shares, portable proofs, receipt/chain/Merkle verification, legacy read-pass routes |
| `sol-app/src/access.ts` | Exact one-time and subscription window/price calculation |
| `sol-app/src/access-routes.ts` | Invitation, offer, quote, Checkout, access-grant and watermarked event-view routes |
| `sol-app/src/billing.ts` | Stripe REST client, Checkout builders, webhook verification/idempotency, legacy activation/subscription lifecycle |
| `sol-app/src/pdf.ts` | In-memory portable-proof PDF creation and HTTP response |

## Automated tests

| File | Coverage focus |
|---|---|
| `access.test.ts` | Whole-transaction discount and subscription time bounds |
| `anchor.test.ts` | Batch binding, protocol, configuration, stale/dropped transaction recovery |
| `auth.test.ts` | Password upgrade, strict sessions, CSRF/origin |
| `billing.test.ts` | Stripe Checkout, dynamic discount, webhook verification and atomic activation |
| `canonical.test.ts` | Canonical determinism and rejection |
| `chain-do.test.ts` | Proof binding, serialization/idempotency/race, atomic D1 writes |
| `merkle.test.ts` | Deterministic roots/proofs and tamper rejection |
| `pdf.test.ts` | Valid PDF structure |
| `receipt-keys.test.ts` | Key-pair correspondence and identity |
| `receipts.test.ts` | Ed25519 canonical signing and public JWK |
| `schema.test.ts` | Trigger-level immutability |
| `totp.test.ts` | RFC vector, replay rejection, encrypted enrollment, recovery hashing |
| `track-h.test.ts` | Case validation and content rejection |
| `track-m.test.ts` | Hash/manifest determinism, transient bytes, path/URL rejection |
| `validation.test.ts` | Registration and canonical delegation |
| `verifier.test.ts` | Hashed shares and trusted-key proof verification |

## D1 migrations

| File | Responsibility |
|---|---|
| `sol-app/migrations/0001_init.sql` | Minimal users, organizations, entitlements, API keys, chains, events, receipts |
| `sol-app/migrations/0002_phase1.sql` | Security/billing/source/scope/anchor/idempotency expansion and evidence immutability triggers |
| `sol-app/migrations/0003_outdock_access.sql` | Organizations/members, event catalog/instances, invitations/offers/orders/grants, disclosure foundations, view logs, priority anchoring |

## Browser and PWA assets

| File | Responsibility |
|---|---|
| `sol-app/public/app.js` | All browser state, forms, fetch/CSRF, local H/C/capsule proof creation and verification |
| `sol-app/public/sw.js` | Cache-first logo/manifest service worker only |
| `sol-app/public/manifest.webmanifest` | Installable Outdock metadata and theme |
| `sol-app/public/od.svg` | App logo |
| `sol-app/public/favicon.ico` | Browser favicon |
| `sol-app/public/.assetsignore` | Asset-pipeline marker/exclusions |

Root `od.svg` is a separate project logo asset. No root PNG exists.

## Contracts and deployment records

| File | Responsibility |
|---|---|
| `contracts/src/OutDock.sol` | Active version-2 role-separated/pauseable batch commitment contract |
| `contracts/src/ODAnchor.sol` | Legacy owner-only batch contract |
| `contracts/OutDock.base-build.json` | Active compiled ABI, bytecode, runtime bytecode and metadata |
| `contracts/OutDock.base-mainnet.json` | Base mainnet deployment record and ABI |
| `contracts/OutDock.polygon-amoy.json` | Polygon Amoy deployment record and ABI |
| `contracts/ODAnchor.base-build.json` | Legacy compiled artifact |
| `contracts/ODAnchor.amoy.json` | Legacy Amoy deployment record |
| `contracts/README.md` | Contract-focused operational notes; partly current |

## Scripts and project configuration

| File | Responsibility |
|---|---|
| `scripts/build-contract.mjs` | Compile active contract |
| `scripts/deploy-mainnet-contract.mjs` | Base deployment |
| `scripts/deploy-amoy-contract.mjs` | Polygon Amoy deployment |
| `scripts/deploy-dev-contract.mjs` | Legacy Base Sepolia ODAnchor deployment |
| `scripts/verify-contract.mjs` | Base/Etherscan source verification |
| `scripts/sanitize-build.mjs` | Remove copied dev secrets from build |
| `scripts/ts-resolver.mjs` | Node test TypeScript import resolution |
| `sol-app/package.json` | Commands and direct dependencies |
| `sol-app/pnpm-lock.yaml` | Exact transitive dependency resolution |
| `sol-app/wrangler.jsonc` | Worker, vars, D1, Durable Object, cron configuration |
| `sol-app/vite.config.ts` | Cloudflare/SSR plugins and loopback development |
| `sol-app/tsconfig.json` | TypeScript compiler options |
| `sol-app/.gitignore` | App-local ignored paths |
| `sol-app/.dev.vars.example` | Partial local variable-name template; auth/receipt values plus commented Polygon placeholders, but not a complete Base/Stripe inventory |
| `sol-app/worker-configuration.d.ts` | Generated Cloudflare binding/runtime types, not authored domain logic |
| `sol-app/README.md` | Stale operational overview; see gap review |

## Root and generated/private areas

| Path | Classification |
|---|---|
| `.env` | Ignored local secrets; names inventoried, values intentionally not reproduced |
| `.gitignore` | Repository ignore rules |
| `.git/` | Git history/objects, not application runtime |
| `sol-app/.dev.vars` | Ignored local Worker secrets |
| `sol-app/node_modules/` | Third-party dependencies described by lockfile, not Outdock source |
| `sol-app/dist/` | Generated deploy build |
| `graphify-out/` | Generated relationship graph/report/cache |
| `.playwright-cli/` | Prior UI test snapshots and console logs |
| `.DS_Store`, `sol-app/.DS_Store` | macOS metadata |

These groups were inventoried but are not represented as Outdock-authored behavior. Secret values were never copied into documentation.
