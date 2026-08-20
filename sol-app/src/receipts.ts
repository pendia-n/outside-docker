import { canonicalBytes, canonicalize, parseCanonicalJson } from './canonical'
import type { RuntimeEnvironment } from './validation'
import {
  HEX_256_PATTERN,
  base64urlDecode,
  base64urlEncode,
  requireInteger,
  requirePlainRecord,
  requireString,
} from './validation'

export const RECEIPT_VERSION = 'OD-RECEIPT-1'
export const RECEIPT_SIGNATURE_ALGORITHM = 'Ed25519'

export type ReceiptTrack = 'H' | 'M'
export type ReceiptAnchorStatus = 'pending_anchor' | 'anchored' | 'anchor_failed'
export interface ReceiptMerkleStep {
  side: 'left' | 'right'
  hash: string
}

/** Authoritative payload signed by the chain service as canonical JSON bytes. */
export interface ReceiptPayload {
  version: typeof RECEIPT_VERSION
  environment: RuntimeEnvironment
  event_id: string
  chain_id: string
  external_ref: string
  track: ReceiptTrack
  event_type: string
  position: number
  commitment: string
  manifest_hash: string
  proof: string
  previous_proof: string | null
  occurred_at: string | null
  received_at: string
  delivery_id: string | null
  sequence: number | null
  sequence_status: string | null
  anchor_status: ReceiptAnchorStatus
  signing_key_id: string
  signature_algorithm: typeof RECEIPT_SIGNATURE_ALGORITHM
  merkle_proof?: ReceiptMerkleStep[] | null
  polygon_transaction_hash?: string | null
}

/** Kept deliberately structural so the Durable Object can inject one signer. */
export interface ReceiptSigner {
  readonly keyId: string
  readonly algorithm: typeof RECEIPT_SIGNATURE_ALGORITHM
  sign(message: Uint8Array): Promise<string>
}

export interface ReceiptVerifier {
  readonly keyId: string
  readonly algorithm: typeof RECEIPT_SIGNATURE_ALGORITHM
  verify(message: Uint8Array, signature: string): Promise<boolean>
}

export interface SignedReceipt {
  receipt: ReceiptPayload
  receipt_json: string
  signature: string
  signing_key_id: string
  signature_algorithm: typeof RECEIPT_SIGNATURE_ALGORITHM
}

export type ReceiptVerificationResult =
  | { valid: true; receipt: ReceiptPayload; canonicalReceipt: string }
  | {
    valid: false
    reason: 'invalid_receipt' | 'key_mismatch' | 'algorithm_mismatch' | 'invalid_signature'
    message: string
  }

export class ReceiptError extends Error {
  readonly code: string

  constructor(message: string, code = 'receipt_error') {
    super(message)
    this.name = 'ReceiptError'
    this.code = code
  }
}

export type Ed25519PrivateKeyInput = CryptoKey | JsonWebKey | string
export type Ed25519PublicKeyInput = CryptoKey | JsonWebKey | string

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey
}

function assertKeyId(keyId: string): string {
  return requireString(keyId, 'signing key ID', { min: 3, max: 128, pattern: /^[A-Za-z0-9._:-]+$/ })
}

function decodeStandardBase64(value: string): Uint8Array {
  const normalized = value.replace(/[\r\n\t ]/gu, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new ReceiptError('Invalid DER key encoding', 'invalid_key')
  try {
    return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0))
  } catch {
    throw new ReceiptError('Invalid DER key encoding', 'invalid_key')
  }
}

function parsePem(value: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): Uint8Array | null {
  const expression = new RegExp(`^-----BEGIN ${label}-----\\s+([A-Za-z0-9+/=\\s]+)\\s+-----END ${label}-----$`, 'u')
  const match = expression.exec(value.trim())
  return match ? decodeStandardBase64(match[1]) : null
}

function parseJwk(value: JsonWebKey | string): JsonWebKey | null {
  if (typeof value !== 'string') return value
  if (!value.trim().startsWith('{')) return null
  try {
    return requirePlainRecord(JSON.parse(value)) as unknown as JsonWebKey
  } catch {
    throw new ReceiptError('Invalid Ed25519 JWK', 'invalid_key')
  }
}

function assertEd25519Jwk(jwk: JsonWebKey, privateKey: boolean): void {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || (privateKey && typeof jwk.d !== 'string')) {
    throw new ReceiptError('JWK must be an Ed25519 OKP key', 'invalid_key')
  }
  if (jwk.alg !== undefined && jwk.alg !== 'EdDSA' && jwk.alg !== 'Ed25519') {
    throw new ReceiptError('JWK algorithm must be EdDSA/Ed25519', 'invalid_key')
  }
  if (jwk.use !== undefined && jwk.use !== 'sig') throw new ReceiptError('JWK use must be sig', 'invalid_key')
}

async function importPrivateKey(input: Ed25519PrivateKeyInput): Promise<CryptoKey> {
  if (isCryptoKey(input)) {
    if (input.type !== 'private' || input.algorithm.name !== 'Ed25519' || !input.usages.includes('sign')) {
      throw new ReceiptError('Invalid Ed25519 private key', 'invalid_key')
    }
    return input
  }
  const jwk = parseJwk(input)
  if (jwk) {
    assertEd25519Jwk(jwk, true)
    const webCryptoJwk = { ...jwk }
    // Engines disagree between the JOSE name EdDSA and WebCrypto name Ed25519.
    delete webCryptoJwk.alg
    return crypto.subtle.importKey('jwk', webCryptoJwk, { name: 'Ed25519' }, false, ['sign'])
  }
  const serialized = input as string
  const der = parsePem(serialized, 'PRIVATE KEY') ?? decodeStandardBase64(serialized)
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign'])
}

async function importPublicKey(input: Ed25519PublicKeyInput): Promise<CryptoKey> {
  if (isCryptoKey(input)) {
    if (input.type !== 'public' || input.algorithm.name !== 'Ed25519' || !input.usages.includes('verify')) {
      throw new ReceiptError('Invalid Ed25519 public key', 'invalid_key')
    }
    return input
  }
  const jwk = parseJwk(input)
  if (jwk) {
    assertEd25519Jwk(jwk, false)
    const publicJwk = { ...jwk }
    delete publicJwk.d
    delete publicJwk.alg
    return crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, true, ['verify'])
  }
  const serialized = input as string
  const der = parsePem(serialized, 'PUBLIC KEY') ?? decodeStandardBase64(serialized)
  return crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, true, ['verify'])
}

/**
 * Build the signer from an external Worker secret containing a private JWK,
 * PKCS#8 PEM, or base64 PKCS#8 DER. The secret is never serialized or returned.
 */
export async function createEd25519ReceiptSigner(
  privateKey: Ed25519PrivateKeyInput,
  keyId: string,
): Promise<ReceiptSigner> {
  const imported = await importPrivateKey(privateKey)
  const normalizedKeyId = assertKeyId(keyId)
  return {
    keyId: normalizedKeyId,
    algorithm: RECEIPT_SIGNATURE_ALGORITHM,
    async sign(message) {
      if (!(message instanceof Uint8Array) || message.length === 0 || message.length > 1_048_576) {
        throw new ReceiptError('Receipt signing input is invalid', 'invalid_message')
      }
      const signature = await crypto.subtle.sign(RECEIPT_SIGNATURE_ALGORITHM, imported, message)
      return base64urlEncode(new Uint8Array(signature))
    },
  }
}

export async function createEd25519ReceiptVerifier(
  publicKey: Ed25519PublicKeyInput,
  keyId: string,
): Promise<ReceiptVerifier> {
  const imported = await importPublicKey(publicKey)
  const normalizedKeyId = assertKeyId(keyId)
  return {
    keyId: normalizedKeyId,
    algorithm: RECEIPT_SIGNATURE_ALGORITHM,
    async verify(message, signature) {
      let decoded: Uint8Array
      try {
        decoded = base64urlDecode(signature, 128)
      } catch {
        return false
      }
      if (decoded.length !== 64) return false
      try {
        return await crypto.subtle.verify(RECEIPT_SIGNATURE_ALGORITHM, imported, decoded, message)
      } catch {
        return false
      }
    },
  }
}

export async function exportEd25519PublicJwk(publicKey: Ed25519PublicKeyInput): Promise<JsonWebKey> {
  const imported = await importPublicKey(publicKey)
  const exported = await crypto.subtle.exportKey('jwk', imported) as unknown as JsonWebKey
  // Workerd's JsonWebKey object exposes optional WebCrypto fields such as
  // `dp` as enumerable properties whose value is undefined. Copy only the
  // public Ed25519 members so the registry document remains strict JSON and
  // can be canonicalized identically in Node, browsers, and Workers.
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: requireString(exported.x, 'x', { min: 43, max: 43, trim: false }),
    alg: 'EdDSA',
    use: 'sig',
  }
}

function nullableString(value: unknown, field: string, maximum = 4096): string | null {
  return value === null ? null : requireString(value, field, { max: maximum, trim: false })
}

function timestamp(value: unknown, field: string): string {
  const parsed = requireString(value, field, { max: 64 })
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    throw new ReceiptError(`${field} must be an ISO-8601 UTC timestamp`, 'invalid_receipt')
  }
  return parsed
}

function hash256(value: unknown, field: string): string {
  return requireString(value, field, { min: 64, max: 64, pattern: HEX_256_PATTERN })
}

function assertOptionalAnchorFields(receipt: Record<string, unknown>, status: ReceiptAnchorStatus): void {
  if (receipt.merkle_proof !== undefined && receipt.merkle_proof !== null) {
    if (!Array.isArray(receipt.merkle_proof) || receipt.merkle_proof.some((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return true
      const step = item as Record<string, unknown>
      return Object.keys(step).length !== 2
        || (step.side !== 'left' && step.side !== 'right')
        || typeof step.hash !== 'string'
        || !HEX_256_PATTERN.test(step.hash)
    })) {
      throw new ReceiptError('merkle_proof is invalid', 'invalid_receipt')
    }
  }
  if (receipt.polygon_transaction_hash !== undefined && receipt.polygon_transaction_hash !== null) {
    requireString(receipt.polygon_transaction_hash, 'polygon_transaction_hash', { pattern: /^0x[0-9a-fA-F]{64}$/, max: 66 })
  }
  if (status === 'anchored' && (!Array.isArray(receipt.merkle_proof) || typeof receipt.polygon_transaction_hash !== 'string')) {
    throw new ReceiptError('Anchored receipts require Merkle and Polygon proof fields', 'invalid_receipt')
  }
}

export function validateReceiptPayload(value: unknown): ReceiptPayload {
  const receipt = requirePlainRecord(value, 'receipt')
  if (receipt.version !== RECEIPT_VERSION) throw new ReceiptError('Unsupported receipt version', 'invalid_receipt')
  if (receipt.environment !== 'dev' && receipt.environment !== 'prod') throw new ReceiptError('Invalid receipt environment', 'invalid_receipt')
  if (receipt.track !== 'H' && receipt.track !== 'M') throw new ReceiptError('Invalid receipt track', 'invalid_receipt')
  if (!['pending_anchor', 'anchored', 'anchor_failed'].includes(receipt.anchor_status as string)) {
    throw new ReceiptError('Invalid anchor status', 'invalid_receipt')
  }
  if (receipt.signature_algorithm !== RECEIPT_SIGNATURE_ALGORITHM) {
    throw new ReceiptError('Unsupported receipt signature algorithm', 'invalid_receipt')
  }
  requireString(receipt.event_id, 'event_id', { max: 128 })
  requireString(receipt.chain_id, 'chain_id', { max: 128 })
  requireString(receipt.external_ref, 'external_ref', { max: 256, trim: false })
  requireString(receipt.event_type, 'event_type', { max: 128 })
  requireInteger(receipt.position, 'position', 1)
  hash256(receipt.commitment, 'commitment')
  hash256(receipt.manifest_hash, 'manifest_hash')
  hash256(receipt.proof, 'proof')
  if (receipt.previous_proof !== null) hash256(receipt.previous_proof, 'previous_proof')
  if (receipt.occurred_at !== null) timestamp(receipt.occurred_at, 'occurred_at')
  timestamp(receipt.received_at, 'received_at')
  nullableString(receipt.delivery_id, 'delivery_id', 256)
  if (receipt.sequence !== null) requireInteger(receipt.sequence, 'sequence', 0)
  nullableString(receipt.sequence_status, 'sequence_status', 64)
  assertKeyId(receipt.signing_key_id as string)
  assertOptionalAnchorFields(receipt, receipt.anchor_status as ReceiptAnchorStatus)
  // This structural serialization pass rejects undefined, class instances, and cycles.
  canonicalize(receipt)
  return receipt as unknown as ReceiptPayload
}

export async function signReceiptPayload(receipt: ReceiptPayload, signer: ReceiptSigner): Promise<SignedReceipt> {
  const validated = validateReceiptPayload(receipt)
  if (validated.signing_key_id !== signer.keyId) throw new ReceiptError('Receipt key ID does not match signer', 'key_mismatch')
  if (validated.signature_algorithm !== signer.algorithm) throw new ReceiptError('Receipt algorithm does not match signer', 'algorithm_mismatch')
  const receiptJson = canonicalize(validated)
  const signature = await signer.sign(canonicalBytes(validated))
  return {
    receipt: validated,
    receipt_json: receiptJson,
    signature,
    signing_key_id: signer.keyId,
    signature_algorithm: signer.algorithm,
  }
}

export async function verifyReceiptPayload(
  receipt: unknown,
  signature: string,
  verifier: ReceiptVerifier,
): Promise<ReceiptVerificationResult> {
  let validated: ReceiptPayload
  try {
    validated = validateReceiptPayload(receipt)
  } catch (error) {
    return { valid: false, reason: 'invalid_receipt', message: error instanceof Error ? error.message : 'Invalid receipt' }
  }
  if (validated.signing_key_id !== verifier.keyId) {
    return { valid: false, reason: 'key_mismatch', message: 'Receipt signing key ID does not match the verification key' }
  }
  if (validated.signature_algorithm !== verifier.algorithm) {
    return { valid: false, reason: 'algorithm_mismatch', message: 'Receipt signature algorithm is unsupported' }
  }
  const valid = await verifier.verify(canonicalBytes(validated), signature)
  return valid
    ? { valid: true, receipt: validated, canonicalReceipt: canonicalize(validated) }
    : { valid: false, reason: 'invalid_signature', message: 'Receipt signature is invalid' }
}

export async function verifyReceiptJson(
  receiptJson: string,
  signature: string,
  verifier: ReceiptVerifier,
): Promise<ReceiptVerificationResult> {
  if (typeof receiptJson !== 'string' || receiptJson.length > 1_048_576) {
    return { valid: false, reason: 'invalid_receipt', message: 'Receipt JSON is invalid' }
  }
  let receipt: unknown
  try {
    receipt = parseCanonicalJson(receiptJson)
  } catch (error) {
    return { valid: false, reason: 'invalid_receipt', message: error instanceof Error ? error.message : 'Receipt JSON is invalid' }
  }
  return verifyReceiptPayload(receipt, signature, verifier)
}

export interface ReceiptPublicKeyDocument {
  version: 'OD-RECEIPT-KEY-1'
  environment: RuntimeEnvironment
  key_id: string
  algorithm: typeof RECEIPT_SIGNATURE_ALGORITHM
  public_key_jwk: JsonWebKey
}

export async function createReceiptPublicKeyDocument(
  publicKey: Ed25519PublicKeyInput,
  keyId: string,
  environment: RuntimeEnvironment,
): Promise<ReceiptPublicKeyDocument> {
  if (environment !== 'dev' && environment !== 'prod') throw new ReceiptError('Invalid key environment', 'invalid_environment')
  return {
    version: 'OD-RECEIPT-KEY-1',
    environment,
    key_id: assertKeyId(keyId),
    algorithm: RECEIPT_SIGNATURE_ALGORITHM,
    public_key_jwk: await exportEd25519PublicJwk(publicKey),
  }
}
