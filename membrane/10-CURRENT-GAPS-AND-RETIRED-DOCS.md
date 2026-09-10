# Current gaps and retired-document review

This file separates implemented behavior from intended behavior. No code was changed during this documentation task.

## Highest-impact current gaps

### 1. Production Supplier signup does not charge

`POST /api/register` directly creates the account in both environments. The implemented `createProductionCheckout` function is never called. Production Suppliers receive no development bypass and therefore cannot write until an entitlement is created another way. The public form also does not expose plan choice or full organization/billing details.

Impact: production onboarding and Supplier monetization are not end-to-end.

### 2. Two verifier authorization models are disconnected

The agreed invitation/offer purchase creates `access_grants`. Older verifier routes require scope-specific `read_pass` entitlements. Purchase does not create that entitlement, so purchased users cannot automatically use legacy portable proof/PDF endpoints.

Impact: one verifier view works while another apparently related API denies access.

### 3. Paid Verifiers cannot reproduce H from current paid data alone

The paid grant response exposes C, manifest hash, receipt, proof, and anchor state. It does not expose the Supplier's local capsule, H, record salt, original note, or original file. The schema contains disclosure-capsule/key-envelope tables but no runtime path uses them.

Impact: paid viewing proves event/chain/anchor integrity, but content-to-H-to-C comparison still requires the Supplier to separately deliver `.odproof`, passcode, and original file where applicable.

### 4. The no-download promise is only a UI policy

The Verifier UI has no download control and responses use no-store/inline headers plus watermarking. The authenticated JSON remains copyable. Older verifier scope routes explicitly return proof and PDF.

Impact: technical controls reduce casual export but cannot enforce non-sharing. Team boundary, contract/ToS, watermark attribution, and audit enforcement remain necessary.

### 5. New `$88/28-day` subscription renewal is incomplete

The initial paid Checkout creates a fixed grant. The newer `outdock_access` webhook path does not process renewal invoices, subscription period changes, cancellation, refund, or payment failure into renewed/revoked access grants.

Impact: calling it a recurring subscription overstates the implemented lifecycle; today it behaves as an initial Stripe subscription Checkout with one application window.

### 6. Priority anchoring can complete before a large range is fully anchored

A priority run selects at most 500 matching events and attaches the request to that batch. Confirmation marks the request complete. Remaining matching pending events are not tracked by the same request.

Impact: a large paid range may still contain unanchored events after its priority request says complete.

### 7. Scheduled cadence is once daily, not “daily or three times weekly” configurable policy

The only committed cron is daily at 01:17 UTC. There is no batch-age/size policy UI, thrice-weekly mode, immediate webhook-triggered anchor execution, or on-demand dispatch from a priority request. Purchases only queue work for the next cron.

### 8. Current UI language is Base-specific in dev

Client verification results label the transaction/reference as Base. Development now anchors and verifies Polygon Amoy.

Impact: dev UI can report cryptographically correct results with misleading chain wording.

## Additional implementation gaps and caveats

- `createProductionCheckout` and legacy `$29/30-day` Read Pass code are unreachable from active registration.
- `/api/billing/checkout` ignores its body and opens the Billing Portal; it is not a first plan Checkout.
- Verifier quote calculation accepts a request-supplied model without loading the offer; Checkout later corrects this by using stored offer model.
- Access-route authentication passes Verifier email as null, so Stripe Checkout does not prefill an existing recovery email.
- Event instances exist in API/schema but are absent from web management flows.
- Organization team membership schema exists but no member/invitation UI/API exists.
- Disclosure capsule and key-envelope tables are unused.
- Source public keys/signatures are stored but not cryptographically verified.
- `receipt_versions` exists but current anchor status changes do not issue new signed receipt versions.
- `share_access_events` exists but public share resolution only updates counters.
- `usage_counters` exists but usage is calculated directly from events.
- Email verification and password reset tables exist without delivery/consumption routes.
- No TOTP disable/regenerate-recovery flow exists.
- No account password-change or account recovery UI exists.
- No explicit event/case/source close/archive routes are mounted.
- Public share behavior exists twice under `/api/public/shares` and `/api/evidence/share`.
- Some nested router errors omit central `request_id`.
- Track H server API trusts client-computed C and manifest hash; it cannot know whether the browser truthfully derived them from content.
- Track M transient JSON/text/base64 crosses the Worker boundary. “Not retained” must not be marketed as “never transmitted.”
- The 15 MB Worker declared body check and Track M's 10 MiB decoded base64 cap differ; requests without Content-Length still reach route-level validation.
- The `.odproof` local proof package cap is 8 MiB; Track H original files may be 128 MiB because file bytes are not embedded.
- Immediate Track H proof downloads include the local capsule, while later server downloads do not. The UI does not warn strongly enough about that one-time retention responsibility.
- A standalone valid event proof/receipt does not establish completeness of the entire chain or the absence of later events.
- Deployer and anchorer were the same address in recorded deployments; the contract supports separation, but operational key separation is not demonstrated by repository data.
- Contract owner should ultimately be a multisig; current deployment record shows an externally owned deployment address.
- Local Base `.env` names (`BASE_RPC`, `BASE_PRIVATE`) do not match the names read by source/scripts (`BASE_RPC_URL`, `BASE_PRIVATE_KEY`); deployment currently depends on manual mapping.
- Ignored `.dev.vars` retains unused TOTP-specific values even though source derives TOTP protection from `JWT_SECRET`; they are legacy local clutter, not runtime requirements.
- Graphify's existing graph includes generated Cloudflare types and historical docs, making broad queries noisy. It is useful for navigation, not authority.

## Review of retired root Markdown

### `design.md` — retired

Historical technical/UX blueprint. It assumes Polygon PoS as the chosen production chain, older route shapes, server-side passcode/capsule concepts, old schema, and build phases. Current code uses dev Polygon Amoy and prod Base, different routes, local Track H capsules, a newer access model, and three migrations. Its still-useful themes—write-only API keys, local hashing, Track boundaries, threat awareness—are captured in this set.

### `od.md` — retired

Large bilingual build manual containing market/legal claims, proposed file structure, Polygon-only anchoring, older APIs and pricing. It is not a reliable current reference and duplicates many sections in two languages. Current architecture, APIs, storage and limitations are now documented without treating market/legal assertions as implementation facts.

### `SHOULD-BE.md` — retired

Phase 1 normative contract. It was useful as acceptance intent, but now conflicts with the active $25/$88 verifier model, event-type invitations, Base production chain, current UI, and implemented/unimplemented boundaries. Requirements that remain material—role separation, H UI+API, M API-only writes, local content control, serialized chains, signed receipts, payment-scoped access—are preserved here.

### `NOW-THAT.md` — retired

An earlier audit that accurately identified missing authorization, Track M, verifier product, Stripe, portable receipts, anchoring, concurrency and MFA at that time. Those features now largely exist, so its “current state” is obsolete. The unresolved parts are restated above against current source.

### `OD-UPGRADE-PLAN.md` — retired

A proposed future model containing categories/procedures, encrypted storage, invitation rooms, Base adapter, phased backlog, and unresolved decisions. Parts were implemented differently; parts remain unimplemented. Keeping it beside current docs would blur roadmap and reality. Current implemented domain objects and remaining gaps are now explicit.

### `IMPLEMENTATION-CHECKLIST.md` — retired

A point-in-time completion checklist. Several boxes became true, others became stale or changed semantics, and a checklist cannot explain the coexistence of legacy and current flows. Test coverage and gaps are now described with evidence.

### `APP.md` — retired

A short generic product explanation under the old “Outside Docker” name. The product definition and limits are now covered by `00-READ-ME-FIRST.md`, while UI identity is Outdock.

## Root files not deleted

Only root Markdown deletion was authorized. Therefore `.env`, `.gitignore`, `.DS_Store`, `od.svg`, `.playwright-cli`, `graphify-out`, all `sol-app` files, and all non-root README files remain unchanged.

## Documentation maintenance rule

Whenever code changes behavior, update the narrowest relevant membrane document in the same commit. Never describe a schema table as a feature unless a mounted route or scheduled path actually reads/writes it. Never describe a Stripe Price variable as required for the agreed product unless an active route reads it. Distinguish local verification, server verification, Merkle membership, and live chain confirmation.
