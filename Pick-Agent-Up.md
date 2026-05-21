# DockDocket — Shipment Discrepancy Claims

Status: In Development

## What It Is

A **claim-evidence web app** for independent retailers and small distributors that lose money from shipment shortages, damages, and wrong-SKU deliveries. Captures receiving events in structured form and turns them into supplier-ready claim packets.

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Cloudflare Worker |
| **Database** | Cloudflare D1 (SQLite) |
| **Frontend** | React + Vite SPA |

## Key Features

- Organization/workspace setup (multi-user)
- Shipment creation with supplier reference
- Discrepancy line items: shortage, damage, wrong SKU
- Claim packet generation with downloadable reports
- Claim status tracking (submitted, acknowledged, resolved)
- Proof documentation (photos, weights, counts)

## Target Market

~30,000 independent retailers and distributors in the US that lose an estimated 2-5% of revenue to unreported shipment discrepancies. Currently many of these businesses absorb the loss because filing claims is too tedious without structured tooling.
