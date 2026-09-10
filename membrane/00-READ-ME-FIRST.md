# Outdock current-version documentation

This directory is the maintained description of the repository as inspected on 2026-09-10. It describes what the code does now, not what an earlier design proposed.

## Authority order

When sources disagree, use this order:

1. executable source in `sol-app/src`, `sol-app/public`, and `sol-app/contracts/src`;
2. D1 migrations in `sol-app/migrations`;
3. automated tests in `sol-app/src/*.test.ts`;
4. deployment configuration and deployment records;
5. this `membrane` documentation;
6. generated artifacts and the remaining README files.

The old root documents were retired after review because they mixed historical Polygon-only architecture, unfinished Phase 1 findings, proposed storage, obsolete pricing, and routes that no longer match the application. Their continuing design intent and every material current gap are preserved in `10-CURRENT-GAPS-AND-RETIRED-DOCS.md`.

## Document map

- `01-SYSTEM-ARCHITECTURE.md`: runtime components, trust boundaries, request flow, environments, and deployed chains.
- `02-ACCOUNTS-AUTH-AND-ROLES.md`: registration, login, sessions, CSRF, TOTP, roles, modes, API keys, and entitlements.
- `03-TRACK-H-AND-TRACK-M.md`: exact Supplier behavior for human and machine records.
- `04-EVIDENCE-CRYPTOGRAPHY-AND-VERIFICATION.md`: H, C, manifest, event proof, receipts, Merkle anchoring, `.odproof`, passcodes, and verification.
- `05-VERIFIER-ACCESS-AND-BILLING.md`: invitations, offers, pricing, Checkout, grants, viewing, sharing, and limitations.
- `06-API-REFERENCE.md`: all current HTTP surfaces and their authorization model.
- `07-D1-SCHEMA.md`: all tables, important columns, relations, immutability rules, and tables not yet used by runtime code.
- `08-UI-UX-PWA.md`: page structure, navigation, interactions, responsive styling, local cryptographic work, and PWA behavior.
- `09-OPERATIONS-CONTRACTS-TESTS-AND-FILES.md`: configuration, schedules, deployments, contract behavior, scripts, tests, and repository inventory.
- `10-CURRENT-GAPS-AND-RETIRED-DOCS.md`: observed incompleteness, contradictions, security/product caveats, and disposition of the deleted root Markdown files.
- `11-SOURCE-FILE-MAP.md`: responsibility map for every authored source/test/schema/asset/config group and generated/private areas.

## One-sentence product definition

Outdock is a Cloudflare Worker application that lets Suppliers append human or machine evidence commitments to owner-scoped, serialized hash chains, immediately issues signed receipts, later anchors batches on Polygon Amoy in development or Base mainnet in production, and gives Verifiers invitation- and payment-scoped web access to selected event-type/time windows.

## What Outdock proves and does not prove

Outdock can prove that a specific commitment was accepted at a recorded server time, that events were ordered in one append-only chain, that a receipt was signed by a registered Outdock key, and—after anchoring—that an event proof was included in a batch committed to the configured chain.

It does not prove that the original content was true, that a device or human was honest, that a file existed before Outdock received the commitment, that a legal tribunal will admit it, or that a person who can view JSON cannot copy it.
