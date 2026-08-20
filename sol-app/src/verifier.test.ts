import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainError, computeEventProof } from './chain-do'
import { createEd25519ReceiptSigner, signReceiptPayload, type ReceiptPayload } from './receipts'
import { hashShareToken, verifyPortableProof, type PortableProofV1 } from './verifier'

test('share tokens are hashed deterministically and plaintext is not the stored value', async () => {
  const token = `od_share_${'a'.repeat(43)}`
  const first = await hashShareToken(token)
  assert.equal(first, await hashShareToken(token))
  assert.notEqual(first, token)
  assert.equal(first.length, 64)
})

test('malformed share tokens use a not-found response', async () => {
  await assert.rejects(() => hashShareToken('short'), (error: unknown) => {
    assert.ok(error instanceof DomainError)
    assert.equal(error.status, 404)
    return true
  })
})

test('portable verification requires a registry-pinned receipt key', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey
  const receivedAt = '2026-01-01T00:00:00.000Z'
  const eventProof = await computeEventProof({
    chainId: 'chain-1', position: 1, receivedAt, commitment: 'a'.repeat(64), previousProof: null,
  })
  const receipt: ReceiptPayload = {
    version: 'OD-RECEIPT-1', environment: 'dev', event_id: 'event-1', chain_id: 'chain-1',
    external_ref: 'CASE-1', track: 'H', event_type: 'CAPTURED', position: 1,
    commitment: 'a'.repeat(64), manifest_hash: 'b'.repeat(64), proof: eventProof,
    previous_proof: null, occurred_at: null, received_at: receivedAt, delivery_id: null,
    sequence: null, sequence_status: null, anchor_status: 'pending_anchor',
    signing_key_id: 'key-1', signature_algorithm: 'Ed25519',
  }
  const signed = await signReceiptPayload(receipt, await createEd25519ReceiptSigner(privateKey, 'key-1'))
  const proof: PortableProofV1 = {
    format: 'odproof', version: 1, environment: 'dev',
    event: {
      id: 'event-1', chain_id: 'chain-1', external_ref: 'CASE-1', track: 'H', event_type: 'CAPTURED',
      position: 1, commitment: receipt.commitment, manifest_hash: receipt.manifest_hash,
      previous_proof: null, proof: eventProof, occurred_at: null, received_at: receivedAt,
      anchor_status: 'pending_anchor',
    },
    receipt: {
      payload: receipt, canonical_json: signed.receipt_json, signature: signed.signature,
      signing_key_id: 'key-1', signature_algorithm: 'Ed25519', public_key_jwk: publicKey,
    },
    anchor: null,
    disclaimer: 'Integrity is not truth.',
  }
  const untrusted = await verifyPortableProof(proof)
  assert.equal(untrusted.valid, false)
  assert.ok(untrusted.failures.includes('receipt_key_untrusted'))
  const trusted = await verifyPortableProof(proof, { trustedPublicKeys: { 'key-1': publicKey } })
  assert.equal(trusted.valid, true)

  const tamperedCommitment = 'd'.repeat(64)
  const tamperedProof = await computeEventProof({
    chainId: 'chain-1', position: 1, receivedAt, commitment: tamperedCommitment, previousProof: null,
  })
  const detachedPayloadAttack: PortableProofV1 = {
    ...proof,
    event: { ...proof.event, commitment: tamperedCommitment, proof: tamperedProof },
    receipt: {
      ...proof.receipt,
      payload: { ...proof.receipt.payload, commitment: tamperedCommitment, proof: tamperedProof },
      // canonical_json and its signature deliberately remain receipt A.
    },
  }
  const attacked = await verifyPortableProof(detachedPayloadAttack, { trustedPublicKeys: { 'key-1': publicKey } })
  assert.equal(attacked.valid, false)
  assert.ok(attacked.failures.includes('receipt_payload_mismatch'))
})
