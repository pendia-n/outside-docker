# Outside Docker App

## What The App Is

Outside Docker is a Cloudflare Worker app for preserving evidence integrity without storing original files. It supports human case records through Track H, machine-generated records through Track M, signed receipts, append-only event chains, scoped verifier access, portable proof exports, PDF proof summaries, and Polygon batch anchoring.

The app is not a file vault and not a truth oracle. It proves that a record was committed, ordered, signed, and, when anchored, included in a public batch commitment. It does not prove that the underlying statement, image, document, or sensor reading was truthful.

## Why It Was Created

Outside Docker was created for situations where people need evidence that can be checked later but should not hand the original content to the infrastructure provider. Healthcare notes, logistics milestones, delivery events, claim files, and machine telemetry can all be sensitive, bulky, or legally constrained.

The app gives suppliers a way to keep original material under their own control while still producing a durable, independently verifiable trail of commitments and receipts.

## What User Problem It Solves

Suppliers need to prove that records existed in a specific sequence and were not silently changed after capture. Verifiers need to inspect that evidence without receiving broad access to a supplier's whole account or relying on a black-box trust claim.

Outside Docker solves this by separating the system into three practical surfaces:

- Track H lets human users create cases, hash local files or structured notes in the browser, append events, and download passcode-protected portable proof packages.
- Track M lets machine gateways submit canonicalized records through scoped API keys, with idempotency and rate limits suitable for retrying unreliable network writes.
- Verifier access lets a reader buy or receive access to a specific published evidence scope, inspect only those events, and verify shared proof artifacts for free when a supplier deliberately shares them.

## How It Reduces Stress For Users

The app reduces stress by making each step explicit. A supplier can see cases, sources, recent receipts, anchor status, billing state, and security settings in one workspace. The user does not have to guess whether original files were uploaded, because the interface and API are designed around local hashing and server-side rejection of retained original content.

Verification is also broken into understandable layers: receipt signature, event-chain proof, manifest binding, content commitment, Merkle inclusion, and Polygon anchor. When a layer is missing or pending, the app reports that state instead of pretending the proof is complete.

For operational users, the app provides practical next steps: create a case, add an event, download a proof, create a share, issue an API key, inspect usage, or open billing. For verifiers, it limits the workspace to the paid or shared scope so review can proceed without exposing unrelated supplier records.

## Why The App Is Unique

Outside Docker's main distinction is that it combines evidence integrity, privacy restraint, and practical verification in one workflow. It does not ask users to upload everything into a central evidence store just to prove integrity later.

The system keeps original content and passcodes outside the Worker, signs receipts with a public-key-verifiable Ed25519 receipt format, serializes chain writes through Durable Objects, stores immutable evidence facts in D1, and anchors only batch commitments on Polygon. This gives suppliers and verifiers a compact proof network: enough structure to audit, not enough stored content to become a new data-risk center.
