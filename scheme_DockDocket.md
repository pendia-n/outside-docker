# Business Plan — DockDocket

## Idea Scope
DockDocket is a claim-evidence web application for independent retailers and small distributors that lose money from shipment shortages, damages, and wrong-SKU deliveries. It captures receiving events in structured form and turns them into supplier-ready claim packets.

## Problem
Independent operators frequently detect inbound shipment discrepancies but fail to recover credits because evidence is fragmented across photos, paper notes, and chat messages. The financial pain is immediate, recurring, and measurable, yet current workflows are ad hoc and non-auditable.

## Users
- Primary users: owner-operators, stock clerks, and receiving staff at convenience stores, specialty retailers, and small wholesalers.
- Secondary users: operations managers and bookkeepers who reconcile claims and supplier credits.
- Buyer profile: microbusinesses with 1-20 staff, high delivery frequency, and limited admin tooling budget.

## MVP Features Only
1. Username/password registration and login (no OAuth, no magic link, no social login).
2. Organization and user workspace setup.
3. Shipment creation with supplier reference, delivery date/time, and optional attachments metadata.
4. Discrepancy line items (shortage, damage, wrong SKU, pricing mismatch) with quantities and notes.
5. Claim packet generation (structured summary + timeline) with downloadable text/JSON report.
6. Claim status tracking (draft, submitted, accepted, rejected, partially credited).
7. Credit wallet and usage accounting:
- Users spend credits when generating claim packets.
- Users can purchase additional credits through Stripe checkout.
8. Basic activity logs and audit fields for accountability.

## System Design
- Client: Server-rendered HTML pages from Worker routes (no separate SPA needed in MVP).
- API: Cloudflare Worker endpoints for auth, shipment/discrepancy CRUD, packet generation, and billing checkout creation.
- Data: Cloudflare D1 as primary relational store for users, sessions, organizations, shipments, line items, credits, and purchases.
- Auth: Password hashing and session tokens with secure cookies; RBAC-lite (owner/staff) in D1.
- Billing: Stripe checkout session creation endpoint + webhook endpoint to credit wallets after successful payment.
- Security controls: input validation, CSRF token on mutating forms, rate limiting per IP + per account, parameterized SQL.

## Monetization
- Free tier: limited monthly claim packet generations (e.g., 5 credits).
- Paid model: credit packs (e.g., 50/200/1000 credits) purchased through Stripe.
- Expansion model (post-MVP): subscription tiers with bundled credits + team seats.
- Allowed gateways used: Stripe (MVP). Optional future addition: BTCPayServer for crypto-preferring wholesalers.

## Assumptions
- Users feel credit recovery pain frequently enough to adopt a focused tool.
- Claim packets with consistent evidence improve supplier response and acceptance rates.
- Users accept credit-based pricing tied to direct monetary recovery outcomes.
- A Worker + D1 architecture is sufficient for early scale and global latency targets.

## Risks
- Behavioral risk: staff may skip logging during busy receiving windows.
- Data quality risk: weak evidence capture can still reduce claim success.
- Integration risk: suppliers have inconsistent claim intake workflows.
- Billing risk: checkout completion may be lower in low-trust markets.
- Regulatory/privacy risk: attachment metadata and user records must be retained carefully.

## Region and Demographic Focus
- Initial region: US, Canada, UK, and English-speaking APAC import-heavy micro-retail.
- Initial demographic: independent retailers and small wholesale operations with frequent supplier deliveries and lean back-office teams.

## Required Stack Specification (for Step 7)

### Hosting approach
- **Choice:** Cloudflare Worker (+ optional Cloudflare Pages-style static assets served by Worker).
- **Justification:** Global low-latency edge runtime, tight D1 integration, and low-cost solo-founder deployment path.

### Frontend approach
- **Choice:** Server-rendered HTML (no separate frontend framework needed).
- **Init CLI command:** `none`
- **Justification:** Minimizes moving parts for MVP and keeps deployment on one Worker runtime.

### Backend framework
- **Choice:** Cloudflare Worker with lightweight routing and modules.
- **Init CLI command:** `npm create cloudflare@latest dockdocket -- --category=hello-world --type=hello-world-with-assets --lang=ts --no-git --no-deploy --accept-defaults`
- **Justification:** Official mature Cloudflare scaffolding with explicit non-interactive flags and Worker + assets structure for full-stack MVP; lowercase app directory satisfies Cloudflare naming rules.

### Database
- **Choice:** Cloudflare D1.
- **Justification:** Default relational store requirement, SQL support, and native Worker bindings.

### Authentication constraint
- **Requirement:** Username + password only for all user-facing auth.
- **No-go:** No OAuth, no social login, no magic links.

### AI Model Provider
- **Choice:** none (MVP does not require generative AI responses).
- **Justification:** Product value is operational evidence workflow, not LLM output.

## Non-MVP (Later)
- Inbox/API integrations with major suppliers.
- OCR extraction from delivery documents and invoices.
- Multi-location analytics and discrepancy benchmarks.
- Supplier-side collaboration portal.
- Crypto checkout option via BTCPayServer.
