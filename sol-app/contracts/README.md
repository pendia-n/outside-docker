# ODAnchor for Base

The contract stores only:

- `batchId`
- `merkleRoot`
- `manifestHash`
- leaf/event counts
- anchor timestamp

It does not store original content, content hashes, metadata, passcodes, encrypted capsules, or ciphertext. The Worker signs and stores receipts; a later anchor job submits the batch commitment.

Run `pnpm run build:contract` to compile a deployment artifact for Base Sepolia (`84532`) and Base mainnet (`8453`). Both networks use ETH for gas. Deploy with Foundry or another audited EVM deployment tool. Deployment stays separate because it is an irreversible public-chain action.
