# Current HTTP API reference

All paths below are mounted by `src/index.tsx`. Browser mutations require `X-CSRF-Token` and same-origin checks unless explicitly public or API-key based. Machine bearer tokens use `Authorization: Bearer od_sk_<env>_...`. Event/source write idempotency uses `Idempotency-Key`.

## Pages and service state

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Landing, registration, and login page |
| GET | `/app` | Authenticated role/mode-specific workspace; otherwise redirects to login |
| GET | `/verify` | Local/public portable-proof verification UI |
| GET | `/verify/:token` | Public shared-evidence page plus local verification UI |
| GET | `/checkout/success` | Checkout-return status page |
| GET | `/checkout/cancelled` | Cancelled Checkout status page |
| GET | `/health` | Environment, selected D1 binding, and active configured chain ID |

## Accounts and security (`/api`)

| Method | Path | Authorization | Behavior |
|---|---|---|---|
| GET | `/api/username/:username` | Public | Validates name and reports activated/pending availability |
| POST | `/api/register` | Public same-origin | Creates Supplier or Verifier immediately; dev Supplier gets bypass entitlement |
| POST | `/api/login` | Public same-origin | Password plus optional required TOTP/recovery; creates cookies/session |
| GET | `/api/session` | Browser session | Returns user and fresh CSRF token |
| POST | `/api/logout` | Session+CSRF when logged in | Revokes current session and clears cookies |
| GET | `/api/dashboard` | Browser session | Counts cases/sources/events/failures, entitlements, recent receipts |
| POST | `/api/security/totp/start` | Session+CSRF | Creates pending authenticator enrollment and QR/manual secret |
| POST | `/api/security/totp/confirm` | Session+CSRF | Confirms code, enables TOTP, returns one-time recovery codes |
| POST | `/api/security/sessions/revoke` | Session+CSRF | Revokes every other session |

## Event catalog (`/api`)

| Method | Path | Authorization | Behavior |
|---|---|---|---|
| GET | `/api/event-types` | Supplier session | Lists owned types with instance/record counts |
| POST | `/api/event-types` | Supplier+active plan+CSRF | Creates stable type |
| GET | `/api/event-types/:eventTypeRef/instances` | Supplier session | Lists owned instances |
| POST | `/api/event-types/:eventTypeRef/instances` | Supplier+active plan+CSRF | Creates active instance |

## Track H (`/api/h`)

| Method | Path | Authorization | Behavior |
|---|---|---|---|
| POST | `/api/h/cases` | Supplier Track H/both+plan+CSRF | Creates case |
| GET | `/api/h/cases` | Supplier session | Lists owned cases |
| GET | `/api/h/cases/:caseRef` | Supplier session | Gets one owned case |
| GET | `/api/h/cases/:caseRef/events` | Supplier session | Gets ordered events and receipts |
| POST | `/api/h/cases/:caseRef/events` | Supplier Track H/both+plan+CSRF+idempotency | Appends commitment |
| POST | `/api/h/cases/:caseRef/events/:eventId/corrections` | Same | Appends correction linked to same chain |

Read routes require Supplier role but do not call `requireSupplierMode`; a Supplier whose configured mode later differs can still read its H cases.

## Track M (`/api/v1`)

| Method | Path | Authorization | Behavior |
|---|---|---|---|
| POST | `/api/v1/sources` | API key `source:write`, or Track M/both session+plan+CSRF | Creates Source idempotently |
| GET | `/api/v1/sources` | API key `source:write`, or Supplier session | Lists owned Sources |
| GET | `/api/v1/sources/:sourceId` | Same | Gets owned Source |
| POST | `/api/v1/records` | API key `record:write`+plan+idempotency | Appends one machine record |
| POST | `/api/v1/records:batch` | API key `record:batch`+plan+idempotency | Sequential idempotent batch |
| GET | `/api/v1/receipts/:eventId` | API key `receipt:read`, or Supplier session | Gets owned M receipt |
| GET | `/api/v1/records?limit=` | Same | Gets 1–200 recent owned records |
| GET | `/api/v1/sources/:sourceId/chain` | Same | Gets ordered Source chain |
| GET | `/api/v1/deliveries/:deliveryId/events` | Same | Gets delivery events across Sources |
| GET | `/api/v1/usage` | API key `usage:read`, or Supplier session | Current-month/current-minute usage |

## API-key management (`/api`)

| Method | Path | Authorization | Behavior |
|---|---|---|---|
| GET | `/api/api-keys` | Supplier session | Lists safe metadata only |
| POST | `/api/api-keys` | Track M/both+plan+CSRF | Issues once-visible plaintext key |
| DELETE | `/api/api-keys/:keyId` | Same | Revokes active owned key |
| POST | `/api/api-keys/:keyId/rotate` | Same | Replaces and returns once-visible key |

## Current invitation and purchase access (`/api`)

| Method | Path | Authorization | Behavior |
|---|---|---|---|
| POST | `/api/supplier/invitations` | Supplier session+CSRF | Creates 14-day event-type invitation and two offers |
| POST | `/api/verifier/invitations/accept` | Verifier session+CSRF | Claims invitation |
| GET | `/api/verifier/offers` | Verifier session | Lists accepted active offers |
| POST | `/api/verifier/offers/:offerId/quote` | Verifier session | Computes $25/7d or $88 window quote |
| POST | `/api/verifier/offers/:offerId/checkout` | Verifier session+CSRF | Creates Stripe Checkout and access order |
| GET | `/api/verifier/grants` | Verifier session | Lists grants |
| GET | `/api/verifier/grants/:grantId/events` | Active owned grant | Returns event window, watermark, view expiry; no-store |

The quote route trusts the request's `access_model` instead of verifying it against `:offerId`; Checkout correctly loads and uses the stored offer model.

## Evidence scopes and portable proof (`/api/evidence`)

| Method | Path | Authorization | Behavior |
|---|---|---|---|
| POST | `/api/evidence/scopes` | Supplier+plan+CSRF | Creates draft scope, optional members |
| POST | `/api/evidence/scopes/:scopeId/members` | Same | Adds owned events, maximum 80 |
| POST | `/api/evidence/scopes/:scopeId/publish` | Same | Publishes non-empty scope |
| POST | `/api/evidence/scopes/:scopeId/shares` | Same | Creates bearer share |
| GET | `/api/evidence/scopes/:scopeId/events/:eventId/proof` | Supplier owner | Gets scoped portable proof |
| GET | `/api/evidence/scopes/:scopeId/events/:eventId/proof.pdf` | Supplier owner | Gets PDF with database-only verification |
| GET | `/api/evidence/verifier/scopes/:scopeId` | Verifier legacy read pass | Gets published scope |
| GET | `/api/evidence/verifier/scopes/:scopeId/events` | Same | Lists scope events |
| GET | `/api/evidence/verifier/scopes/:scopeId/events/:eventId/proof[.pdf]` | Same | Gets portable proof/PDF |
| GET | `/api/evidence/share/:token` | Public bearer token | Resolves public share |
| GET | `/api/evidence/share/:token/events/:eventId/proof[.pdf]` | Public bearer token | Gets shared proof/PDF if enabled |

## Convenience share/proof routes (`/api`)

| Method | Path | Authorization | Behavior |
|---|---|---|---|
| GET | `/api/shares` | Supplier session | Lists shares and publishable case/scopes; non-Supplier gets empty arrays |
| POST | `/api/shares` | Supplier+plan+CSRF | Auto-publishes case scope if needed; creates 1–365-day share |
| GET | `/api/public/shares/:token` | Public bearer token | Resolves share |
| GET | `/api/public/shares/:token/events/:eventId/proof[.pdf]` | Public bearer token | Shared proof/PDF |
| GET | `/api/events/:eventId/proof[.pdf]` | Supplier owner | Owner portable proof/PDF |
| GET | `/api/receipt-public-key?key_id=` | Public | Active/default or active/retired registered receipt key |
| POST | `/api/verify-proof` | Public | Full trusted proof verification; `422` for invalid layers |

Two public-share route families implement overlapping behavior.

## Billing and anchoring

| Method | Path | Authorization | Behavior |
|---|---|---|---|
| POST | `/api/billing/portal` | Session+CSRF+Stripe customer | Creates Billing Portal session |
| POST | `/api/billing/checkout` | Supplier session | Calls the same Billing Portal helper; despite name it is not new Checkout |
| GET | `/api/anchors/priority` | Supplier session | Lists owned priority requests |
| POST | `/api/anchors/priority` | Supplier+active plan+CSRF | Queues owned non-empty event-type range |
| POST | `/api/webhooks/stripe` | Valid Stripe signature | Idempotently fulfills new access or legacy billing events |

There is no `/api/stripe/webhook`; the live mounted webhook is `/api/webhooks/stripe`. Some remaining README text names the old path.

## Error envelope

Central errors use `{ error, code, request_id }`. Several nested routers catch `DomainError` themselves and return `{ error, code }` without request ID. Unknown paths return `404 not_found` with request ID.
