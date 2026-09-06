# OutDock for Base

The contract stores only:

- `batchId`
- `merkleRoot`
- `manifestHash`
- leaf/event counts
- anchor timestamp

It does not store original content, content hashes, metadata, passcodes, encrypted capsules, or ciphertext. The Worker signs and stores receipts; a later anchor job submits the batch commitment.

`OutDock.sol` keeps the legacy `AnchorBatch` event and `verify` function compatible, while adding:

- a separately revocable `anchorer` role for the Worker hot wallet;
- an owner-controlled emergency pause for new anchors;
- a per-batch protocol ID (`OD1` today, `OD2` when the application migrates);
- rejection of zero digests and empty batches; and
- complete batch verification through `verifyBatch`.

The owner should ultimately be a Safe or equivalent multisig. The Worker wallet should remain only an authorised anchorer. Ownership uses a two-step transfer so it cannot be accidentally handed to an address that cannot accept it.

Run `pnpm run build:contract` to compile the deterministic deployment artifact. For Base mainnet (`8453`), provide `BASE_RPC_URL` and `BASE_PRIVATE_KEY`, then run `pnpm run deploy:contract:base`. Provide `ETHERSCAN_API_KEY` and run `pnpm run verify:contract:base` to submit exact compiler input to Etherscan V2. All three credentials are runtime secrets and must never be committed.
