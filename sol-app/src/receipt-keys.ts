import { canonicalize } from './canonical'
import {
  createEd25519ReceiptSigner,
  createEd25519ReceiptVerifier,
  createReceiptPublicKeyDocument,
  type ReceiptPublicKeyDocument,
  type ReceiptSigner,
} from './receipts'
import type { Env } from './types'
import { utf8 } from './validation'

const RECEIPT_KEY_PAIR_PROOF_DOMAIN = 'outside-docker/receipt-key-pair-proof/v1'

function required(environment: Env, name: keyof Env): string {
  const value = environment[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${String(name)} is not configured`)
  return value
}

export function receiptKeyId(environment: Env): string {
  return required(environment, 'RECEIPT_KEY_ID')
}

async function verifiedReceiptKeys(environment: Env): Promise<{
  signer: ReceiptSigner
  publicKey: ReceiptPublicKeyDocument
}> {
  const keyId = receiptKeyId(environment)
  const privateKey = required(environment, 'RECEIPT_PRIVATE_KEY_JWK')
  const publicKey = required(environment, 'RECEIPT_PUBLIC_KEY_JWK')
  const [signer, verifier, document] = await Promise.all([
    createEd25519ReceiptSigner(privateKey, keyId),
    createEd25519ReceiptVerifier(publicKey, keyId),
    createReceiptPublicKeyDocument(publicKey, keyId, environment.ENV),
  ])
  // Prove possession across the configured pair before either key is used or
  // registered. The NUL-separated, domain-bound challenge cannot be confused
  // with canonical receipt bytes.
  const challenge = utf8(`${RECEIPT_KEY_PAIR_PROOF_DOMAIN}\0${environment.ENV}\0${keyId}`)
  const signature = await signer.sign(challenge)
  if (!await verifier.verify(challenge, signature)) {
    throw new Error('Configured receipt private and public keys do not match')
  }
  return { signer, publicKey: document }
}

export async function receiptSigner(environment: Env): Promise<ReceiptSigner> {
  return (await verifiedReceiptKeys(environment)).signer
}

export async function receiptPublicKey(environment: Env): Promise<ReceiptPublicKeyDocument> {
  return (await verifiedReceiptKeys(environment)).publicKey
}

export async function ensureReceiptPublicKey(database: D1Database, environment: Env): Promise<ReceiptPublicKeyDocument> {
  // Matching is deliberately established before the first database call.
  const { publicKey: document } = await verifiedReceiptKeys(environment)
  const publicKeyJson = canonicalize(document.public_key_jwk)
  await database.prepare(`
    INSERT OR IGNORE INTO receipt_signing_keys (
      id, environment, algorithm, public_key_jwk, status, valid_from, created_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).bind(
    document.key_id,
    document.environment,
    document.algorithm,
    publicKeyJson,
    new Date().toISOString(),
    new Date().toISOString(),
  ).run()
  const stored = await database.prepare(`
    SELECT environment, algorithm, public_key_jwk, status
    FROM receipt_signing_keys WHERE id = ? LIMIT 1
  `).bind(document.key_id).first<{ environment: string; algorithm: string; public_key_jwk: string; status: string }>()
  if (
    !stored
    || stored.environment !== document.environment
    || stored.algorithm !== document.algorithm
    || stored.public_key_jwk !== publicKeyJson
    || stored.status !== 'active'
  ) throw new Error('Configured receipt key does not match the registered public key')
  return document
}
