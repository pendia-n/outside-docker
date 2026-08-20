import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureReceiptPublicKey, receiptPublicKey, receiptSigner } from './receipt-keys'
import type { Env } from './types'

async function keyPairJwks(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  return {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) as unknown as JsonWebKey,
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) as unknown as JsonWebKey,
  }
}

function receiptEnvironment(privateJwk: JsonWebKey, publicJwk: JsonWebKey): Env {
  return {
    ENV: 'dev',
    RECEIPT_KEY_ID: 'receipt-dev-v1',
    RECEIPT_PRIVATE_KEY_JWK: JSON.stringify(privateJwk),
    RECEIPT_PUBLIC_KEY_JWK: JSON.stringify(publicJwk),
  } as unknown as Env
}

test('configured receipt private/public keys must match before registration writes', async () => {
  const first = await keyPairJwks()
  const second = await keyPairJwks()
  let databaseWasAccessed = false
  const database = {
    prepare() {
      databaseWasAccessed = true
      throw new Error('database must not be accessed for mismatched keys')
    },
  } as unknown as D1Database

  await assert.rejects(
    ensureReceiptPublicKey(database, receiptEnvironment(first.privateJwk, second.publicJwk)),
    /private and public keys do not match/u,
  )
  assert.equal(databaseWasAccessed, false)
})

test('matching receipt keys produce the same registered key identity', async () => {
  const pair = await keyPairJwks()
  const environment = receiptEnvironment(pair.privateJwk, pair.publicJwk)
  const [signer, publicKey] = await Promise.all([
    receiptSigner(environment),
    receiptPublicKey(environment),
  ])
  assert.equal(signer.keyId, publicKey.key_id)
  assert.equal(publicKey.environment, 'dev')
  assert.equal(publicKey.algorithm, 'Ed25519')
})
