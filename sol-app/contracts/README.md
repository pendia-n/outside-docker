# ODAnchor

The contract stores only:

- `batchId`
- `merkleRoot`
- `manifestHash`
- leaf/event counts
- anchor timestamp

It does not store original content, content hashes, metadata, passcodes, encrypted capsules, or ciphertext. The Worker signs and stores receipts; a later anchor job submits the batch commitment.

Deploy with Foundry or another audited EVM deployment tool. Deployment is intentionally separate from application build because it is an irreversible public-chain action.
