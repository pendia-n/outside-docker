# Verifier access, payments, and controlled disclosure

## Account and invitation

A Verifier registers as role `verifier`; there is no Track H/M mode. The Supplier creates an event type, then creates a private invitation for that type. The server returns a one-time-visible token prefixed `odi_`; D1 stores a domain-separated SHA-256 token hash and display prefix, not the plaintext. The invitation expires after 14 days.

Creating one invitation also creates two active offers for the same Supplier event type:

- `one_time_range`
- `subscription_28d`

The Verifier logs in, enters the token in the web workspace, and atomically claims the pending invitation. An accepted invitation is linked to the Verifier user and organization. It cannot be accepted again.

## One-time historical range

The Verifier selects an end-exclusive start/end timestamp. Any partial 7-day period rounds up:

```text
units = ceil((rangeEnd - rangeStart) / 604800 seconds)
```

Pricing is exact:

- 1–6 units: `$25 × units`;
- 7 or more units in the same transaction: the **entire transaction** is 50% of the undiscounted total, implemented as `$12.50 × all units`;
- maximum range per Checkout: 520 units (ten years).

There is one normal `$25/7-day` Stripe Price ID. At seven units or more, the Worker creates dynamic Stripe `price_data` at 1,250 cents for every unit. There is no separate discounted Price ID.

After a verified successful payment, this grant has the selected fixed data range and an application access expiry of year 9999. It does not include events whose effective time is outside the purchased range, even when those events are added later.

## 28-day subscription

The price is `$88`. At paid time `T`:

- data begins at `T - 30 days`;
- data ends at `T + 28 days`;
- application access begins at `T` and ends at `T + 28 days`;
- events arriving during those 28 days are visible if their effective timestamp falls before the end.

The Checkout uses Stripe subscription mode and the configured `STRIPE_PRICE_VERIFIER_SUBSCRIPTION_28D`. Current fulfillment creates one fixed `access_grant` window from the initial Checkout. The inspected code does not process renewal invoices or subscription-period updates for this newer `outdock_access` model, so automatic recurring renewal beyond the first 28-day window is incomplete.

## Quote and Checkout integrity

The server computes the quote; it does not trust an amount from the browser. Checkout metadata binds environment, access order ID, model, and username. One-time Checkout uses payment mode; subscription uses subscription mode. The webhook:

1. verifies Stripe signature timestamp and raw-body HMAC;
2. claims the Stripe event idempotently in D1;
3. requires a paid Checkout Session;
4. binds environment, order ID, model, Checkout Session, USD currency, and exact amount;
5. requires PaymentIntent for one-time or Subscription ID for subscription;
6. inserts one access grant and fulfills the order in a D1 batch;
7. creates a priority anchor request for the paid event range.

## Viewing purchased evidence

An active grant is owner/type/time scoped. Effective event time is `COALESCE(occurred_at, received_at)`. The response returns event identity, order, C, manifest hash, chain proof, anchor state, and signed receipt. It creates a 15-minute view-session row, a unique visible watermark reference, and a `list/allowed` access-log entry. Response headers use `Cache-Control: no-store` and `Content-Disposition: inline`.

The UI labels this “web review only · no download” and provides no download button. This is deterrence and workflow design, not a technical impossibility: the JSON API response is visible to the authenticated browser and can be copied by a determined user or developer tools. Team/external sharing policy therefore also requires contracts, Terms of Service, organization membership controls, audit review, and enforcement outside this code.

The organization-membership schema supports owner/admin/member/auditor roles, but current UI and routes do not yet provide team invitation or membership CRUD. A newly registered Verifier is simply the owner of its own verifier organization.

## Priority anchoring after purchase

Every fulfilled purchase inserts a pending priority request for that Supplier/event type/range. The next daily anchoring run chooses the oldest priority request before normal events and anchors unbatched matching events, up to 500.

If no matching unanchored events remain, the request is marked complete. If more than 500 matching events are pending, current implementation attaches the request to the first 500-event batch and completes the request when that batch confirms; it does not keep the same request open until every remaining matching event is anchored. This is a material completeness gap.

## Public Supplier sharing is separate from paid access

A Supplier can publish an immutable evidence scope and create an expiring/max-view bearer link. This is free deliberate sharing, separate from event-type purchase grants. Share tokens are stored hashed. Public access can list the published scope and obtain portable proof/PDF if allowed. A ten-minute continuation window prevents one normal page/proof/PDF sequence from consuming multiple max views.

The current UI can automatically turn a Track H case with events into a published scope before creating the share. Published scope members and facts are protected by D1 triggers.

## Legacy verifier/read-pass subsystem

An older subsystem still exists:

- `evidence_scopes` plus members;
- `entitlements.kind=read_pass` scoped to a published scope;
- legacy `$29 / 30-day` constants and `STRIPE_PRICE_READ_PASS`;
- production pending-registration activation code;
- `/api/verifier/scopes*` and `/api/evidence/verifier/scopes*` routes.

The active registration route does not invoke legacy Checkout creation, and the newer $25/$88 offer flow creates `access_grants`, not read-pass entitlements. These paths coexist but are not integrated. New deployments should not treat `STRIPE_PRICE_READ_PASS` as part of the current agreed verifier offer unless the legacy path is deliberately restored.

## Supplier plan billing

Supplier plan codes and stored prices are A `$99`, B `$299`, C `$799`, and D `$1,999`, with different write/batch limits. `createSupplierSubscriptionCheckout` and webhook activation are implemented, but the active registration route bypasses that Checkout in all environments. Existing Suppliers with a Stripe customer can open the Billing Portal; `/api/billing/checkout` currently redirects to that same portal rather than creating a new plan purchase.

Therefore supplier pricing exists in schema/client/webhook logic, but end-to-end production signup payment is not currently wired.
