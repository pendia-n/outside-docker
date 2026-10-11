# Katzar: product and code plan

## Product

Katzar is a one-to-one conversation with a visible end time. The creator shares a single-use link only with the person they want to chat with. Both people sign up with a unique username and strong password; there is no email, phone number, or password recovery. The recipient joins and replies for free.

The public homepage explains the service, the one-person invite, room expiry, privacy limits, and pricing. Its calls to action lead to signup and sign-in. After signing in, users reach a chat list with a **Start a chat** action. The homepage is never a room or a waitlist.

Free: text only, two hours after the recipient joins. Full: one-time **$2 Stripe Checkout payment per room**, text plus files and recorded voice, with a creator-selected duration up to three days after joining. A creator who only needs a few hours can select a shorter duration for the same price. No subscription and no charge to the recipient. An unclaimed invite expires after 24 hours.

The recipient's explicit **Quit** revokes their access; the creator keeps the existing content until deadline but can no longer send. Returning to the list is not Quit. The creator's explicit Quit destroys the room for both. On expiry, the server blocks reads and writes, notifies both open tabs, removes active content, and sends viewers to the chat list. Open tabs also check expiry when waking from sleep. All displayed timestamps use fixed UTC+03:00.

Full-plan files: PDF, PNG, DOCX, Pages, JPG/JPEG, GIF, XLS/XLSX, CSV; maximum 5 MB before encryption; participants can download. Voice notes are recorded in-app, maximum 5 MB, and expire eight hours after sending or at room expiry, whichever comes first. The player has no download button, but no web app can stop browser capture. Do not claim audio is technically undownloadable.

## Screens

| Route | Purpose |
| --- | --- |
| `/` | Intro, exact plan comparison, privacy explanation, signup/sign-in links |
| `/signup`, `/signin` | Username/password account access |
| `/chats` | Room list, statuses, expiry, Start a chat, theme switch |
| `/invite/:id` | Review and explicitly claim a one-person invite |
| `/chats/:id` | Messages, expiry clock, allowed composer, Quit |
| `/privacy`, `/terms` | Retention limits, payment and product terms |

Use `od.svg` for navbar logo and favicon, plus an ICO fallback. Support phone, tablet, desktop, light and dark themes, and a PWA shell. The service worker must never cache room responses or decrypted content. A privacy veil can blur messages when the tab loses focus or on demand, with a quick reveal control; normal text must remain legible and accessible.

## Architecture

Astro renders pages on Cloudflare Workers. A custom Worker entrypoint handles authenticated APIs and ordinary pages; room clients poll for updates every three seconds. A SQLite-backed Durable Object alarm per room schedules expiry and voice deletion, with a one-minute Worker cron as a retry path. D1 stores accounts, sessions, room state, and encrypted text/metadata. Private R2 stores encrypted files and voice. Stripe Checkout handles the one-time payment; a signed webhook, not the success redirect, marks the room paid.

Browser-side AES-GCM encrypts text, file content/names, and voice with a per-room key. The invite URL fragment carries the room key and invite token; fragments are not sent with HTTP requests. The creator and recipient keep the key in device-local storage for revisits. Losing the key/device means losing access to old content. The Worker never stores a room key or plaintext chat data. Do not load third-party analytics/scripts in chat views. Enforce content security policy, output escaping, origin checks, rate limits, session/role checks, and server-side media limits.

Authentication uses a signed JWT in a Secure, HttpOnly, SameSite=Lax cookie lasting 23 hours, with a D1 session ID for revocation. The JWT HMAC secret is generated with `openssl rand -hex 32`, stored only in ignored root `.env`, and uploaded as a Worker secret. Passwords get a unique salt and expensive one-way hash. Usernames are unique after case folding.

The server stores UTC milliseconds; views always format UTC+3 explicitly. The server is authoritative for room timing. Remove active D1 and R2 data at expiry, and never promise instant erasure from Cloudflare backups or from recipient devices. D1 Time Travel can retain historical encrypted bytes after active-row deletion.

## D1 migration

```sql
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE rooms (id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id), recipient_id TEXT REFERENCES users(id),
  invite_token_hash TEXT NOT NULL UNIQUE, tier TEXT NOT NULL CHECK(tier IN ('free','full')),
  duration_seconds INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending_payment','inviting','active','ended')),
  created_at INTEGER NOT NULL, invite_expires_at INTEGER NOT NULL,
  joined_at INTEGER, expires_at INTEGER, recipient_left_at INTEGER, ended_at INTEGER,
  checkout_session_id TEXT UNIQUE);
CREATE TABLE messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  sender_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('text','file','audio')),
  ciphertext BLOB NOT NULL, iv BLOB NOT NULL, media_id TEXT,
  sent_at INTEGER NOT NULL, expires_at INTEGER);
CREATE INDEX messages_room_time ON messages(room_id,sent_at);
CREATE TABLE media (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  r2_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('file','audio')),
  size_bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE payment_events (stripe_event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
```

Room creation stores a high-entropy token hash. Invitation claim is a conditional database update so two simultaneous visitors cannot both join. Room destruction first makes all API reads/writes inaccessible, closes sockets, then deletes R2 objects and dependent D1 rows; cleanup retries partial work because R2 and D1 cannot be changed atomically together.

## Stripe implementation and setup

The server starts a Checkout Session with `mode=payment`, inline one-time USD $2.00 price data, quantity one, a unique room ID in `client_reference_id`/metadata, and success/cancel URLs. No pre-created product or Price ID is needed. Persist the Checkout Session ID against a `pending_payment` room. Do not expose the Stripe secret key to the browser.

Create a Dashboard webhook endpoint at `https://<your-domain>/api/stripe/webhook` for `checkout.session.completed`, `checkout.session.expired`, and, if delayed payment methods are enabled, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`. Save the endpoint signing secret as `STRIPE_WEBHOOK_SECRET` in Worker secrets; use a least-privilege restricted API key as `STRIPE_API_KEY` there too. The Worker verifies `Stripe-Signature` against the **raw request body** and signing secret, rejects stale/invalid signatures, checks `mode=payment`, `payment_status=paid`, amount=200 USD cents, currency=usd, expected room and Checkout Session IDs, and records Stripe event IDs idempotently. Only then set the room to `inviting`. A user returning via the Checkout cancel link triggers a server-side expiration attempt; the pending room is deleted only after Stripe confirms it expired unpaid. The expired webhook cleans up if the user simply closes the tab. Handle duplicate and out-of-order delivery safely. A success page polls room state and does not grant access by itself.

For local testing, use Stripe CLI to forward events to the local webhook URL, and use its temporary `whsec_...` value only in local ignored secrets. Test a completed payment, failed/cancelled payment, duplicate webhook, invalid signature, and a success redirect without a webhook. Configure the production Dashboard endpoint separately; its signing secret differs from the CLI secret.

## Delivery and acceptance

1. Intro page, responsive theme, logo/favicon, PWA shell, auth screens.
2. D1 schema, username/password auth, 23-hour session, rate/origin guards.
3. Two-account free room: single-claim link, encrypted text, room polling, list and Quit rules, forced expiry and deletion.
4. One-time paid Checkout, verified webhook, chosen duration, encrypted R2 files, recorded voice, cleanup.
5. Verify open/asleep tabs at expiry, concurrent claims, unauthorized account denial, media size/type limits, duplicate Stripe events, mobile/tablet/desktop, both themes, and actual D1/R2 cleanup before launch.

Commercial proof comes from invite-to-claim and paid-room conversion, not waitlist signups. First make a complete free conversation work end to end, then finish and test the paid path before presenting it as available.
