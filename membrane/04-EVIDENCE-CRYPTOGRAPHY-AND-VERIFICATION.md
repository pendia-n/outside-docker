# Evidence, cryptography, anchoring, and verification

## Terminology

- **Original content:** exact file bytes, text, JSON, audio, video, image, or other material.
- **H:** `SHA-256(original canonical bytes)`; a content-equality fingerprint.
- **Record salt:** 32 random bytes selected per record.
- **C / commitment:** `SHA-256(UTF8("OD1|CONTENT|") || salt || H)`.
- **Manifest hash:** SHA-256 of canonical record context.
- **Event proof:** the append-only chain link.
- **Receipt:** canonical event statement signed by Outdock.
- **Merkle leaf/root:** membership commitment for a later batch.
- **On-chain anchor:** one contract record containing only batch-level values.

SHA-256 is one-way. C is never “unhashed.” Verification recomputes H from the presented original, recomputes C from H plus the retained salt, and checks equality against the committed C. The salt and H must therefore be recoverable from a disclosure package if content comparison is intended.

## Canonical JSON

Object keys are recursively sorted. Arrays preserve order. Strings, booleans, null, and finite numbers are encoded deterministically, with negative zero rendered as zero. Sparse arrays, unsupported JavaScript types, non-finite numbers, non-plain/prototype-bearing objects, cycles, and lossy values are rejected. The parser can require input text to be the exact canonical representation.

## Event proof

For each append:

```text
proof = SHA-256(
  UTF8("OD1|EVENT|" + chainId + "|" + position + "|" + receivedAt + "|" + commitment + "|" + (previousProof || ""))
)
```

The chain ID is a random UUID created with the first event. Position starts at 1. `receivedAt` is Worker time. Each subsequent event includes the preceding proof. This proves ordering and detects removal/reordering when validating a sequence, but a standalone event proof does not by itself prove that no later event exists.

## Signed receipt

The immediate `OD-RECEIPT-1` payload binds environment, event/chain/external identifiers, track, action, position, C, manifest hash, proof, previous proof, occurred/received times, optional delivery and sequence facts, initial `pending_anchor`, receipt signing key ID, and Ed25519 algorithm.

The exact canonical receipt JSON is signed with Ed25519. D1 stores the receipt, payload hash, signature, algorithm, key ID, and status projection. Registered active and retired public keys remain retrievable by key ID. The system verifies that configured private and public keys match before registration/signing.

The signed receipt permanently says `pending_anchor`; later anchoring does not rewrite signed facts. D1's mutable `receipts.anchor_status` and event status are projections, and later `receipt_versions` can hold new signed representations. This separation prevents an unsigned status update from pretending the original signature covered future chain confirmation.

## Merkle batch

Each leaf is:

```text
SHA-256(UTF8("OD1|MERKLE|" + eventId + "|" + eventProof))
```

Parents are `SHA-256(UTF8("OD1|NODE|" + left + "|" + right))`. With an odd number of nodes the last is duplicated. The batch manifest lists algorithm, event count, event ID, event proof, leaf index, and leaf hash. Its canonical hash and the Merkle root produce:

```text
batchRef = SHA-256(UTF8("OD1|ANCHOR|" + root + "|" + manifestHash + "|" + eventCount))
```

D1 stores each event's leaf index, leaf hash, and proof path. The public contract stores `batchId`, root, manifest hash, leaf/event counts, protocol ID, and timestamp.

## OutDock contract

`OutDock.sol` version 2 permits only authorized anchorers to submit. It rejects zero protocol/batch/root/manifest values, empty counts, duplicates, and submissions while paused. Owner can add/revoke anchorers, pause, and initiate two-step ownership transfer. `verify` preserves compatibility with the old contract; `verifyBatch` checks protocol and counts as well.

No original content, H, record salt, passcode, receipt, payment, verifier identity, access grant, or per-event commitment C is written directly to the contract. A verifier proves an event's inclusion by combining the event proof with its Merkle path and comparing the resulting root to the anchored batch.

## Portable `.odproof`

A current portable proof has format `odproof`, version 1, environment, event projection, signed receipt envelope, optional anchor data, disclaimer, and—for a locally created Track H package—local manifest and encrypted capsule.

The server-generated portable proof contains event, receipt, and anchor fields but does not contain the Supplier browser's local manifest or encrypted capsule because those were never uploaded. The browser-generated package includes them because it assembles the package immediately after the append response.

## Passcode semantics

The passcode protects only the local Track H capsule. It is not a blockchain password, not sent to the smart contract, not stored in D1, and not automatically delivered to a paid Verifier. Supplier and Verifier use the same passcode for that particular encrypted capsule because AES decryption must derive the same key.

The Supplier does not need the passcode to see C, the receipt, or blockchain anchor. The Supplier needs it later to decrypt the capsule and recover H/salt (and original structured text, if the evidence was a note). A Verifier needs the package plus its passcode and, for file evidence, the separately supplied original file.

## Browser verification layers

The UI can check:

1. proof-package size, nesting, field bounds, and supported format;
2. receipt key ID against Outdock's trusted public-key endpoint;
3. Ed25519 signature over exact canonical receipt JSON;
4. event fields against signed receipt fields;
5. recomputed event proof;
6. optional manifest binding and manifest hash;
7. optional capsule decryption and recomputed C;
8. embedded structured-text H or separately supplied original-file H;
9. optional Merkle membership, leaf hash, and leaf index;
10. anchor field syntax and state consistency;
11. server-side RPC verification of the configured contract record, transaction receipt, block number/hash, and matching `AnchorBatch` log.

The server returns `422` with layer failures for an invalid proof. Anchorless signed proofs can be valid before batching. If anchor data is included, full server verification requires the configured dev/prod chain and matching contract.

## Important current limitation

Paid Verifier event-window responses contain C, manifest hash, chain proof, receipt, and anchor reference when available. They do not contain the Supplier's local encrypted capsule, H, salt, original note, or file. Therefore payment alone currently supports integrity/sequence/anchor review but does not automatically enable content-to-H-to-C comparison. Supplier-controlled disclosure remains a separate manual step.
