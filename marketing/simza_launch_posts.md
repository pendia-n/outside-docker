# DockDocket Launch Posts (simza)

## Substack Post
**Title:** The Money Leak at the Loading Dock  
Small retailers lose real money when inbound deliveries arrive short, damaged, or mislabeled and no one can prove what happened cleanly. DockDocket fixes that with a simple workflow: log shipment discrepancy evidence, generate a claim packet, and submit with confidence.  

This MVP is intentionally narrow:
- Username/password account access only.
- D1-backed evidence records and claim timelines.
- Credit-based claim packet generation.
- Stripe checkout for additional credits.

If you run a store and process frequent distributor deliveries, I want your feedback on whether this changes your weekly credit-recovery rate.

Live app: https://dockdocket.pendia-community.workers.dev

## Twitter/X Thread
1. Most small retailers don’t lose margin on pricing.  
They lose it at receiving: shortages, damage, wrong SKU, weak evidence.
2. Built a focused tool for this: **DockDocket**.
3. Log discrepancies in structured form.
4. Generate a claim packet with timeline + line-item evidence.
5. Track status: draft / submitted / accepted / rejected / partial.
6. Credit-based model: spend 1 credit per packet, buy packs via Stripe.
7. Stack: Cloudflare Worker + D1, username/password auth only.
8. If you manage deliveries weekly, test it and tell me what’s missing:
https://dockdocket.pendia-community.workers.dev

## Reddit Post
**Title:** Built a tiny app to recover supplier credits from bad deliveries (feedback wanted)  
I keep seeing small retailers lose money on shipment discrepancies because evidence is spread across notes/photos/chats. I built DockDocket as a focused MVP:
- Record shipment + discrepancy details.
- Generate a claim packet (1 credit per packet).
- Track claim status.
- Buy extra credits via Stripe.

It’s built on Cloudflare Worker + D1 and uses username/password login only.  
If you run a small store or wholesale operation, I’d value blunt feedback on:
1. What claim evidence fields are mandatory in real workflows?
2. What makes suppliers reject claims most often?
3. What export format do you actually need?

App: https://dockdocket.pendia-community.workers.dev

## Product Hunt Post
**Tagline:** Turn shipment discrepancy chaos into claim-ready evidence in minutes.  
**Description:** DockDocket helps small retailers recover credits from supplier shortages, damage, and wrong-SKU deliveries. Capture discrepancy details, generate structured claim packets, and track outcomes. Built for lean operations that can’t afford enterprise procurement software.  

**Key MVP Features**
- Username/password auth.
- Shipment + discrepancy capture.
- Claim packet generation and status tracking.
- Credit wallet + Stripe credit pack checkout.

**Who It’s For**
- Convenience stores
- Specialty retailers
- Small distributors

**Ask**
Share your current claim rejection reasons and must-have fields for v2.
