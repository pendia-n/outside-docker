import assert from 'node:assert/strict'
import test from 'node:test'
import { verifySessionToken } from './auth'
import {
  createEd25519ReceiptSigner,
  createEd25519ReceiptVerifier,
  createReceiptPublicKeyDocument,
  signReceiptPayload,
  verifyReceiptJson,
  verifyReceiptPayload,
  type ReceiptPayload,
} from './receipts'

async function keyPairJwks(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  return {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) as unknown as JsonWebKey,
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) as unknown as JsonWebKey,
  }
}

function receipt(): ReceiptPayload {
  return {
    version: 'OD-RECEIPT-1',
    environment: 'dev',
    event_id: 'event-1',
    chain_id: 'chain-1',
    external_ref: 'case-1',
    track: 'H',
    event_type: 'document_captured',
    position: 1,
    commitment: 'a'.repeat(64),
    manifest_hash: 'b'.repeat(64),
    proof: 'c'.repeat(64),
    previous_proof: null,
    occurred_at: '2026-08-20T00:00:00.000Z',
    received_at: '2026-08-20T00:00:01.000Z',
    delivery_id: null,
    sequence: null,
    sequence_status: null,
    anchor_status: 'pending_anchor',
    signing_key_id: 'receipt-dev-v1',
    signature_algorithm: 'Ed25519',
  }
}

test('Ed25519 signs exact canonical receipt bytes and public key verification detects tampering', async () => {
  const { privateJwk, publicJwk } = await keyPairJwks()
  const signer = await createEd25519ReceiptSigner(privateJwk, 'receipt-dev-v1')
  const verifier = await createEd25519ReceiptVerifier(publicJwk, 'receipt-dev-v1')
  const signed = await signReceiptPayload(receipt(), signer)
  assert.equal((await verifyReceiptJson(signed.receipt_json, signed.signature, verifier)).valid, true)
  assert.equal((await verifyReceiptPayload({ ...signed.receipt, commitment: 'd'.repeat(64) }, signed.signature, verifier)).valid, false)
  assert.equal(signed.signature.includes('.'), false)
  assert.equal(await verifySessionToken(signed.signature, {
    secret: 'session-secret-that-is-longer-than-thirty-two-bytes', environment: 'dev',
  }), null)
})

test('published Ed25519 JWK contains only portable public members', async () => {
  const { publicJwk } = await keyPairJwks()
  const document = await createReceiptPublicKeyDocument(publicJwk, 'receipt-dev-v1', 'dev')
  assert.deepEqual(Object.keys(document.public_key_jwk).sort(), ['alg', 'crv', 'kty', 'use', 'x'])
  assert.equal(Object.values(document.public_key_jwk).includes(undefined), false)
})
