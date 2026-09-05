# Outdock implementation checklist

This file tracks the accepted product direction against verified code. A checked item must have implementation and test evidence; plans alone stay unchecked.

## Product identity and interface

- [x] Render role-specific Supplier and Verifier workspaces without hidden cross-role panels.
- [x] Keep Supplier Track H available through UI and API.
- [x] Keep Supplier Track M writes API-only, with UI limited to credentials, source configuration, and history.
- [ ] Give Verifiers a Web-only invitation, purchase, review, and comparison journey.
- [ ] Use a light-only responsive layout for 13-inch desktop, iPad Air, mobile, and narrow folding phones.
- [x] Change user-visible branding, SEO, and descriptions to Outdock while retaining repository, Worker, D1, and deployed URL names.
- [x] Add installable PWA metadata and a safe static-asset service worker.

## Authentication and security baseline

- [x] Keep username and password as the only required initial registration fields.
- [x] Enforce unique usernames and visible asynchronous availability feedback.
- [x] Enforce the same 7-18 character, letter-plus-digit password policy in UI and API.
- [ ] Support registration, login, logout, session, recovery, and reset through APIs and UI.
- [x] Keep 28-day Secure, HttpOnly, SameSite=Lax sessions and server-authoritative role checks.
- [ ] Keep optional email, TOTP, recovery passcode, and security-question recovery modular.
- [ ] Verify Supplier and Verifier registration/login with local test accounts only.

## Evidence and access model

- [ ] Separate Event Type, Event Instance, and append-only Event Record.
- [ ] Replace shared proof passcodes with encrypted disclosure capsules and authorization-bound key envelopes.
- [ ] Never retain original content by default for text, PDF, image, MP3, MP4, or other files.
- [ ] Provide optional encrypted object storage: first 100 MB free, then $10 per additional 100 MB after billing cadence is confirmed.
- [ ] Add Supplier invitations and Verifier organization/team membership.
- [ ] Restrict ordinary Verifier access to Web review with watermarks and access logs; no proof/data download.
- [ ] Keep an explicitly authorized, audited legal/court export path separate from ordinary access.

## Verifier billing

- [ ] Implement one-time access quoted in 7-day units at $25 each.
- [ ] Apply 50% to the seventh and later 7-day units within the same checkout.
- [ ] Implement $88 subscriptions granting 28 days of access, a 30-day historical lookback at purchase, and new records through expiry.
- [ ] Create access grants only from verified Stripe webhooks and server-calculated amounts.
- [ ] Replace raw scope-ID registration with account-first, invitation/event-selection checkout.

## API and anchoring

- [ ] Make Track M API accept structured strings or local-file bytes programmatically, hash ephemerally, and return content hash, commitment, manifest, and signed receipt without retaining originals.
- [ ] Preserve API-key scopes, owner authorization, idempotency, rate limits, and append ordering.
- [x] Run normal anchoring daily or on the configured three-times-weekly schedule.
- [x] Split oversized normal batches into bounded sub-batches.
- [ ] Add Supplier-authorized/manual priority batches for a purchased Supplier + Event Type + time range.
- [ ] Show Recorded, Receipted, Queued, Submitted, and Confirmed states accurately.
- [x] Move runtime chain configuration and UI wording from Polygon to Base.
- [x] Compile and test the Base-compatible contract without deploying it.

## Completion gates

- [ ] Apply all D1 migrations locally and verify schema invariants.
- [ ] Pass typecheck, unit/integration tests, production build, and contract compilation.
- [ ] Verify registration/login and role boundaries through both UI and API.
- [ ] Verify Track H UI/API and Track M API with text and local-document fixtures.
- [ ] Verify normal and manual anchor selection without broadcasting a transaction.
- [ ] Produce the exact required Worker vars/secrets list, separating required, optional, and Stripe values still to be created.
- [ ] Commit meaningful completed increments and force-push `origin main` without absorbing unrelated user edits.
