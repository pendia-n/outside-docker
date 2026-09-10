# Current UI, UX, and PWA behavior

## Visual system

The application is light-mode only. It uses a warm cream background, terracotta and sage accents, dark ink text, large editorial headings, rounded cards, thin borders, and generous whitespace. The landing page combines a navigation bar, split hero, proof-chain illustration, industry strip, three-layer explanation, Track H/M comparison, workflow steps, registration/login area, FAQ, and footer.

The CSS has desktop-first layouts with responsive breakpoints at 980px and 680px. Large screens use two-column hero, split panels, sidebar application shell, multi-column metric cards, and two-column surfaces. At narrower widths the sidebar becomes a top block, navigation wraps, grids collapse, and paddings/type sizes reduce. There is no dark-mode stylesheet.

The brand shown in the web UI is “Outdock.” The Cloudflare Worker name, some internal identifiers, MIME types, issuer strings, README text, and `/health` app field still contain “outside-docker.”

## Landing and onboarding UX

The navigation links to explanation, tracks, verification, FAQ, sign-in, and registration. Registration dynamically shows Supplier mode controls or Verifier explanation. Username availability is checked after a debounce. Password feedback enforces 7–18 characters plus letters and digits.

Submitting registration creates the account and then switches focus toward login; it does not redirect to Stripe or automatically log the user in. Supplier organization/billing details and plan choice are not present in the current public form despite backend fields and landing text implying later completion.

Login first sends username/password. If the API returns `totp_required`, the authenticator/recovery field becomes visible and the user resubmits.

## Application shell and role partition

The authenticated shell has a left sidebar and one visible main panel at a time. Navigation state is mirrored into the URL hash.

All users receive Overview, Billing, and Security. A Supplier receives Track H when mode includes H, Track M when mode includes M, and Proofs & Sharing. A Verifier receives Event Access. The application does not present role switching because one user has one role.

Overview shows case/source/event counts, anchor health, recent receipts, identity/mode/environment, and entitlements.

## Track H interface

Track H uses a two-pane workspace:

- case list and inline “new case” form;
- selected case title, add-record form, and vertical timeline.

The add-record form contains event type, action/status, occurred time, local file, alternative note, portable-proof passcode, and optional correction target. The file is read locally; the passcode is used locally. On success the browser automatically downloads `.odproof`, closes/resets the form, reloads case timeline/dashboard, and shows a transient notice.

Timeline cards show action, position, local-formatted time, proof digest, anchor status, proof download, and PDF link. A proof downloaded later from the server does not contain the locally created capsule or manifest; only the immediate auto-download has them.

## Track M interface

The Track M panel manages once-visible scoped API keys and Sources and displays the latest 50 machine events plus usage. It deliberately has no machine record submission form. Key rotation/revocation asks for browser confirmation; rotation displays the replacement once. Source creation uses a retained form idempotency key until success.

The UI can create/list Sources but does not expose event-instance management, delivery filtering, complete chain browsing, arbitrary record pagination, or direct receipt retrieval even though APIs exist.

## Supplier proofs and sharing

The Supplier proof panel supports local `.odproof` verification with optional passcode and original file, share creation, event-type creation, Verifier invitation generation, and priority-anchor requests.

Share and invitation secrets are written into visible text areas for the Supplier to copy. There is no built-in email/WhatsApp delivery and no clipboard button. The share UI selects an already published scope or a case that the server can turn into a scope.

## Verifier interface

The Verifier enters a Supplier invitation token, sees the two offers, selects one, optionally chooses local datetime start/end, requests an exact quote, and continues to Stripe. Local datetime values are converted to ISO UTC before submission.

Grants show Supplier/event type, model and boundaries. Selecting a grant fetches its events and displays a unique watermark plus the 15-minute view expiry. No download link is rendered. The page does not currently expose original-content comparison, passcode/capsule upload, Merkle/chain layer drill-down, team management, or legal-export workflow within a paid grant.

## Verification UI

The public and Supplier-local forms accept `.odproof`, optional passcode, and optional original comparison file. Results are rendered as Verified, Partially Verified, or Verification Failed with per-layer rows. The client performs local checks and asks the Worker for trusted key/chain verification. Legacy proof format is accepted locally but cannot be server-verified.

For a public share token, the page also loads shared event cards with portable-proof and optional PDF links. The explanatory note correctly says original comparison still needs original content and any separately shared capsule passcode.

## Accessibility and interaction details

Forms use labels, required fields, `aria-live` result regions, `aria-busy`, disabled buttons during operations, semantic details/summary in FAQ, and clear focusable buttons/links. Errors are surfaced in notices or result panels. Dynamic HTML uses explicit escaping for server values.

Limitations include reliance on `confirm()` for key destruction, transient notices that disappear after six seconds, no explicit focus transfer after most errors, and visual verification labels that always say “Base” even while dev runs on Polygon Amoy.

## PWA behavior

The manifest names Outdock, starts at `/app`, uses standalone display, cream theme/background colors, and the SVG logo as maskable icon. The service worker registers after page load and cache-first stores only `/od.svg` and `/manifest.webmanifest`. It does not cache HTML, JavaScript, CSS, API responses, or evidence, so this is installable branding/static caching rather than an offline-capable evidence application.

The service worker ignores non-GET and cross-origin requests and deletes older named caches on activation.

## Content retention UX promise

The interface consistently says the default is local/private hashing. For Track H this is accurate for file bytes, salt, passcode, and capsule. For Track M, raw JSON/text/base64 may transit the Worker to be hashed, even though it is not intentionally persisted. This distinction should remain explicit: “not retained” is not the same as “never transmitted.”
