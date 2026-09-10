# Accounts, authentication, roles, and credentials

## Identity model

An account has exactly one immutable application role: `supplier` or `verifier`. A Supplier additionally has one initial mode: `H`, `M`, or `both`. It is not one account simultaneously acting as Supplier and Verifier. A Supplier with `both` may use Track H and Track M under the same Supplier identity.

The UI displays only the panels allowed by server-rendered role/mode input, and the APIs independently enforce the same boundary. Hiding a panel is not treated as authorization.

## Registration inputs and validation

The public registration form supplies username, password, optional recovery email, role, and Supplier mode. The backend also accepts Supplier organization/address fields, plan code, and auto-renew fields even though the current public form does not expose all of them.

- Username is lowercased and must match `[a-z0-9_-]{3,32}`.
- Password is 7–18 characters with at least one ASCII letter and one digit.
- Optional recovery email is restricted to Gmail or Hotmail addresses.
- Supplier mode accepts `H`, `M`, `both`; legacy input `HM` is normalized to `both`.
- Supplier plan defaults to `A` if omitted and can be `A`–`D`.
- Verifier accounts have no Supplier mode or plan code.
- Username availability checks both activated users and still-open pending registrations.

## What registration actually does now

`POST /api/register` always calls the immediate `createAccount` path in both dev and prod. It inserts the user, one organization row, and an owner organization-membership row.

In development only, a Supplier also receives a ten-year `writer_plan` entitlement marked `development_bypass`. In production the immediate registration path does not create an entitlement and does not invoke Stripe Checkout.

There is a separate `createProductionCheckout` function and a substantial pending-registration/webhook activation model, but the active `/api/register` route does not call it. Therefore current code does **not** implement the README claim that production registration activates only after Stripe payment. This is recorded as a current gap, not silently described as working.

## Password storage and login

Passwords use PBKDF2-HMAC-SHA-256 with format `pbkdf2-sha256$v=2$i=100000$<salt>$<digest>`, a 32-byte random salt, and a 32-byte digest. Login performs dummy PBKDF2 work for missing users to reduce username timing leakage. A successfully verified older supported hash is upgraded on login.

Login rejects inactive or disabled users. If TOTP is enabled, the same login call must include either a valid six-digit authenticator code or unused recovery code. On success, the Worker records last login, creates a D1 session record, and sets authentication cookies.

## Session security

The browser session token is a strict HS256 JWT-like token with an `od-session+jwt` header type. Claims bind issuer, audience, user ID, username, role, environment, session version, token ID, issue/not-before/expiry times, and format version. Tokens last at most 28 days.

The `od_session` cookie is HttpOnly, SameSite Strict, path `/`, and Secure on HTTPS or in prod. The readable `od_csrf` cookie carries a session-bound random token with an HMAC. Mutations compare cookie and `X-CSRF-Token`, validate the HMAC, and enforce same-origin/allowed-origin headers.

Every authenticated request re-reads current D1 user state and validates username, role, active/disabled state, and `session_version`. It also verifies the token hash and session ID against an unrevoked, unexpired `auth_sessions` row. Revoking other sessions sets `revoked_at` on every other current user session.

## TOTP and recovery codes

TOTP is optional and uses standard authenticator apps. Enrollment generates a 20-byte Base32 secret and an `otpauth://` URI plus SVG QR code. The secret is stored only as an AES-256-GCM envelope.

There is deliberately no separately managed TOTP encryption secret. The TOTP encryption key and recovery-code HMAC pepper are independently domain-derived from required `JWT_SECRET`. The stored envelope is also bound to user ID, environment, and a derived key ID. Recovery codes are shown once, stored only as keyed hashes, and consumed atomically. A used TOTP counter cannot be replayed.

This design means rotating `JWT_SECRET` without a migration strategy also makes existing TOTP envelopes and recovery hashes unusable.

## Supplier authorization

Supplier write operations require:

- current authenticated Supplier session for UI/management operations, or an active environment-matching API key for machine record operations;
- enabled Supplier mode (`H`, `M`, or `both`) where the route checks it;
- an active/trialing, time-valid `writer_plan` entitlement;
- CSRF for browser mutations;
- plan rate limits for evidence writes.

The event-catalog write route checks an active plan but does not explicitly check that the Supplier mode contains H or M. The evidence-scope publishing route similarly requires a Supplier and active plan without mode restriction.

## Track M API keys

Keys are generated as `od_sk_<environment>_<random>`. D1 stores SHA-256 of the full key, a display prefix, label, environment, lifecycle timestamps, and scopes. Supported scopes are:

- `source:write`
- `record:write`
- `record:batch`
- `receipt:read`
- `usage:read`

The plaintext is returned only on issue and rotation. Listing never returns it. Rotation creates a replacement with the same label/scopes/expiry and immediately revokes the old key. Authentication checks prefix environment, hash, key status/expiry, user status, and Supplier role, then updates `last_used_at`.

The browser UI can create, rotate, revoke, and review keys, and can register/review Sources. Actual machine record submission is API-only.

## Entitlements

`writer_plan` controls Supplier writes. `read_pass` belongs to the older evidence-scope verifier API. The newer event-type purchase system uses `access_grants` directly rather than creating `read_pass` entitlements. Consequently two verifier authorization models coexist:

- legacy published scope + `entitlements.kind=read_pass`;
- current invitation/offer/order + `access_grants` event-window access.

They are not automatically bridged by current code.
