# Katzar

A one-to-one room with a visible ending. The free tier provides two hours of encrypted text after the invited person joins. Full rooms use a one-time $2 Stripe Checkout payment, a chosen duration up to three days, encrypted attachments up to 5 MB, and in-browser voice notes up to 5 MB. The recipient does not pay. Pay for three Full rooms within one rolling 120-hour period to earn eight free Full room credits, automatically applied to later Full rooms.

Current Cloudflare Worker: https://katzar.pendia-community.workers.dev. Full rooms remain disabled until a Stripe API key and webhook signing secret are configured. The homepage and chat list explain that status rather than initiating an incomplete payment.

## Run locally

Use Node 22.12+ and pnpm. `pnpm install`, then apply the database schema with `pnpm exec wrangler d1 migrations apply katzar --local`. A root `.env` needs `KATZAR_JWT_SECRET`, generated with `openssl rand -hex 32`. Keep the value private and never commit it. Build with `pnpm build`, then run the complete Worker locally with `pnpm exec wrangler dev --local`. `pnpm exec astro check` checks source and templates. The app has a public intro at `/`, account pages, chat list, invitation claim page, and room page.

The live Worker uses D1 database `katzar`, private R2 bucket `katzar-media`, per-room Durable Object alarms, and a one-minute cleanup cron. The JWT signing value was deployed through Wrangler's `--secrets-file .env` option and appears as a hidden Worker binding. Only names and IDs belong in Git.

## Set up one-time Stripe Checkout

1. In a Stripe sandbox, create a least-privilege restricted API key that can create Checkout Sessions. Save it as Worker secret `STRIPE_API_KEY`. Do not put it in browser code or Git. No product or Price ID is needed: the server specifies a one-time USD $2.00 line item directly in each Checkout Session.
2. In Stripe Workbench, add an HTTPS **Snapshot** webhook endpoint: `https://katzar.pendia-community.workers.dev/api/stripe/webhook`. Listen for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.expired`. Save this endpoint's `whsec_...` signing value as Worker secret `STRIPE_WEBHOOK_SECRET`. The local Stripe CLI listener uses a *different* signing secret. The app expires an open Checkout Session when the user returns through Stripe's cancel link; the expired event also cleans up pending rooms if the browser is closed instead.
3. The server creates a hosted Checkout Session with `mode=payment`, inline USD $2.00 price data, and a room ID. The success redirect only returns to the chat list. The signed webhook checks the raw body, paid status, $2 amount, USD currency, matching room and Checkout Session, then unlocks the invite. Duplicate events are safe to retry.
4. Test the sandbox payment with Stripe's published test card, a failed payment, a cancelled Checkout, delayed payment, duplicate webhook, and an invalid signature. Check that only a confirmed payment creates a usable Full invitation. Configure separate live-mode restricted key and webhook secret before accepting real payments. Tax settings and refund terms require a business decision; no automatic tax calculation is enabled here.

The installed Stripe CLI profile on this machine currently has an expired account key, so no real Stripe Checkout transaction was run by this build. The webhook logic was integration-tested locally using a disposable signing key and simulated event.

## Privacy and retention

Messages and media are encrypted in the browser with a room key carried in the invitation URL fragment and saved on each participant's device. Losing that key means old content cannot be recovered. The Worker enforces room roles and expiry, removes expired active D1 rows and R2 objects, and retries on a scheduled job. An open room checks the deadline and returns the viewer to the chat list. A recipient can Quit without destroying the creator's view; a creator can Quit and delete the room for both.

This is not a guarantee that copies vanish from a participant's device or provider backups. Voice has no download control, but a browser can still capture it. The service worker caches only the public shell, not chat content. The app has no password recovery.

See [APP.md](./APP.md) for the complete flow and data model.
