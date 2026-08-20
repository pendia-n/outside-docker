import type { RuntimeEnvironment } from './validation'
import {
  base64urlDecode,
  base64urlEncode,
  bytesToHex,
  decodeUtf8,
  randomBytes,
  requireInteger,
  requireString,
  timingSafeEqual,
  utf8,
} from './validation'

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

export interface TotpParameters {
  algorithm: TotpAlgorithm
  digits: 6 | 8
  period: number
}

export const DEFAULT_TOTP_PARAMETERS: Readonly<TotpParameters> = Object.freeze({
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
})

export const TOTP_SECRET_ENVELOPE_VERSION = 'OD-TOTP-SECRET-1'
export const RECOVERY_HASH_VERSION = 'OD-RECOVERY-HMAC-1'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export class TotpError extends Error {
  readonly code: string

  constructor(message: string, code = 'totp_error') {
    super(message)
    this.name = 'TotpError'
    this.code = code
  }
}

function assertTotpParameters(parameters: TotpParameters): void {
  if (!['SHA1', 'SHA256', 'SHA512'].includes(parameters.algorithm)) {
    throw new TotpError('Unsupported TOTP algorithm', 'unsupported_algorithm')
  }
  if (parameters.digits !== 6 && parameters.digits !== 8) throw new TotpError('TOTP digits must be 6 or 8', 'invalid_digits')
  requireInteger(parameters.period, 'TOTP period', 15, 120)
}

export function base32Encode(input: Uint8Array): string {
  let buffer = 0
  let bits = 0
  let output = ''
  for (const byte of input) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  return output
}

export function base32Decode(value: string): Uint8Array {
  const normalized = value.trim().toUpperCase().replaceAll(' ', '').replace(/=+$/u, '')
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new TotpError('Invalid Base32 secret', 'invalid_secret')
  let buffer = 0
  let bits = 0
  const output: number[] = []
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character)
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw new TotpError('Invalid Base32 padding bits', 'invalid_secret')
  return Uint8Array.from(output)
}

export function generateTotpSecret(byteLength = 20): string {
  requireInteger(byteLength, 'TOTP secret length', 20, 64)
  return base32Encode(randomBytes(byteLength))
}

function webCryptoHash(algorithm: TotpAlgorithm): string {
  if (algorithm === 'SHA1') return 'SHA-1'
  if (algorithm === 'SHA256') return 'SHA-256'
  return 'SHA-512'
}

async function hotp(secret: Uint8Array, counter: number, parameters: TotpParameters): Promise<string> {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new TotpError('Invalid TOTP counter', 'invalid_counter')
  const counterBytes = new Uint8Array(8)
  new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter), false)
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: webCryptoHash(parameters.algorithm) },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes))
  const offset = digest[digest.length - 1] & 0x0f
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3]
  ) >>> 0
  return String(binary % (10 ** parameters.digits)).padStart(parameters.digits, '0')
}

export async function generateTotpCode(
  secretBase32: string,
  timestampMs = Date.now(),
  parameters: TotpParameters = DEFAULT_TOTP_PARAMETERS,
): Promise<string> {
  assertTotpParameters(parameters)
  if (!Number.isFinite(timestampMs) || timestampMs < 0) throw new TotpError('Invalid timestamp', 'invalid_timestamp')
  const secret = base32Decode(secretBase32)
  if (secret.length < 20) throw new TotpError('TOTP secret must contain at least 160 bits', 'weak_secret')
  const counter = Math.floor(timestampMs / 1000 / parameters.period)
  return hotp(secret, counter, parameters)
}

export interface TotpVerificationOptions {
  timestampMs?: number
  window?: number
  lastUsedCounter?: number | null
  parameters?: TotpParameters
}

export interface TotpVerificationResult {
  valid: boolean
  counter: number | null
  delta: number | null
  replayed: boolean
}

export async function verifyTotpCode(
  secretBase32: string,
  code: string,
  options: TotpVerificationOptions = {},
): Promise<TotpVerificationResult> {
  const parameters = options.parameters ?? DEFAULT_TOTP_PARAMETERS
  assertTotpParameters(parameters)
  const normalizedCode = typeof code === 'string' ? code.replace(/[\s-]/gu, '') : ''
  if (!new RegExp(`^\\d{${parameters.digits}}$`).test(normalizedCode)) {
    return { valid: false, counter: null, delta: null, replayed: false }
  }
  const timestampMs = options.timestampMs ?? Date.now()
  if (!Number.isFinite(timestampMs) || timestampMs < 0) throw new TotpError('Invalid timestamp', 'invalid_timestamp')
  const window = requireInteger(options.window ?? 1, 'TOTP window', 0, 5)
  const currentCounter = Math.floor(timestampMs / 1000 / parameters.period)
  const secret = base32Decode(secretBase32)
  if (secret.length < 20) throw new TotpError('TOTP secret must contain at least 160 bits', 'weak_secret')
  const supplied = utf8(normalizedCode)
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = currentCounter + delta
    if (counter < 0) continue
    const expected = utf8(await hotp(secret, counter, parameters))
    if (timingSafeEqual(supplied, expected)) {
      const replayed = options.lastUsedCounter !== undefined
        && options.lastUsedCounter !== null
        && counter <= options.lastUsedCounter
      return { valid: !replayed, counter, delta, replayed }
    }
  }
  return { valid: false, counter: null, delta: null, replayed: false }
}

export interface TotpEnrollment {
  secret: string
  otpauthUri: string
  parameters: TotpParameters
}

export function createTotpEnrollment(
  issuer: string,
  accountName: string,
  parameters: TotpParameters = DEFAULT_TOTP_PARAMETERS,
): TotpEnrollment {
  assertTotpParameters(parameters)
  const normalizedIssuer = requireString(issuer, 'issuer', { max: 64 }).replaceAll(':', ' ')
  const normalizedAccount = requireString(accountName, 'accountName', { max: 128 }).replaceAll(':', ' ')
  const secret = generateTotpSecret()
  const label = encodeURIComponent(`${normalizedIssuer}:${normalizedAccount}`)
  const query = new URLSearchParams({
    secret,
    issuer: normalizedIssuer,
    algorithm: parameters.algorithm,
    digits: String(parameters.digits),
    period: String(parameters.period),
  })
  return { secret, otpauthUri: `otpauth://totp/${label}?${query.toString()}`, parameters: { ...parameters } }
}

export interface TotpEncryptionContext {
  userId: string
  environment: RuntimeEnvironment
  keyId: string
}

export interface TotpSecretEnvelope {
  version: typeof TOTP_SECRET_ENVELOPE_VERSION
  algorithm: 'AES-256-GCM'
  key_id: string
  iv: string
  ciphertext: string
}

export type TotpEncryptionKey = CryptoKey | Uint8Array | string

function encryptionContext(context: TotpEncryptionContext): string {
  const userId = requireString(context.userId, 'userId', { max: 128 })
  const keyId = requireString(context.keyId, 'keyId', { max: 128, pattern: /^[A-Za-z0-9._:-]+$/ })
  if (context.environment !== 'dev' && context.environment !== 'prod') throw new TotpError('Invalid environment', 'invalid_environment')
  return `OD1-TOTP-SECRET|${context.environment}|${userId}|${keyId}`
}

async function resolveAesKey(key: TotpEncryptionKey, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (typeof CryptoKey !== 'undefined' && key instanceof CryptoKey) {
    if (key.algorithm.name !== 'AES-GCM' || !key.usages.includes(usage)) {
      throw new TotpError('TOTP encryption key has the wrong algorithm or usage', 'invalid_encryption_key')
    }
    return key
  }
  const bytes = typeof key === 'string' ? base64urlDecode(key, 64) : key
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new TotpError('TOTP encryption key must be 32 bytes encoded as base64url', 'invalid_encryption_key')
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [usage])
}

export async function encryptTotpSecret(
  secretBase32: string,
  key: TotpEncryptionKey,
  context: TotpEncryptionContext,
): Promise<TotpSecretEnvelope> {
  const secret = secretBase32.trim().toUpperCase()
  if (base32Decode(secret).length < 20) throw new TotpError('TOTP secret must contain at least 160 bits', 'weak_secret')
  const imported = await resolveAesKey(key, 'encrypt')
  const iv = randomBytes(12)
  const additionalData = utf8(encryptionContext(context))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, imported, utf8(secret))
  return {
    version: TOTP_SECRET_ENVELOPE_VERSION,
    algorithm: 'AES-256-GCM',
    key_id: context.keyId,
    iv: base64urlEncode(iv),
    ciphertext: base64urlEncode(new Uint8Array(ciphertext)),
  }
}

export async function decryptTotpSecret(
  envelope: TotpSecretEnvelope,
  key: TotpEncryptionKey,
  context: TotpEncryptionContext,
): Promise<string> {
  if (
    envelope.version !== TOTP_SECRET_ENVELOPE_VERSION
    || envelope.algorithm !== 'AES-256-GCM'
    || envelope.key_id !== context.keyId
  ) throw new TotpError('Unsupported TOTP secret envelope', 'invalid_envelope')
  const imported = await resolveAesKey(key, 'decrypt')
  const iv = base64urlDecode(envelope.iv, 32)
  const ciphertext = base64urlDecode(envelope.ciphertext, 4096)
  if (iv.length !== 12 || ciphertext.length < 17) throw new TotpError('Invalid TOTP secret envelope', 'invalid_envelope')
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(encryptionContext(context)), tagLength: 128 },
      imported,
      ciphertext,
    )
    const secret = decodeUtf8(new Uint8Array(plaintext))
    if (base32Decode(secret).length < 20) throw new Error('weak secret')
    return secret
  } catch {
    throw new TotpError('TOTP secret could not be decrypted', 'decryption_failed')
  }
}

export async function confirmTotpEnrollment(
  envelope: TotpSecretEnvelope,
  key: TotpEncryptionKey,
  context: TotpEncryptionContext,
  code: string,
  options: TotpVerificationOptions = {},
): Promise<TotpVerificationResult> {
  const secret = await decryptTotpSecret(envelope, key, context)
  return verifyTotpCode(secret, code, options)
}

function normalizeRecoveryCode(code: string): string {
  const normalized = typeof code === 'string' ? code.toUpperCase().replace(/[\s-]/gu, '') : ''
  if (!new RegExp(`^[${RECOVERY_ALPHABET}]{12}$`).test(normalized)) {
    throw new TotpError('Invalid recovery code', 'invalid_recovery_code')
  }
  return normalized
}

export function generateRecoveryCodes(count = 10): string[] {
  requireInteger(count, 'recovery code count', 1, 20)
  const output = new Set<string>()
  while (output.size < count) {
    const random = randomBytes(12)
    let code = ''
    for (const value of random) code += RECOVERY_ALPHABET[value % RECOVERY_ALPHABET.length]
    output.add(`${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`)
  }
  return [...output]
}

export interface RecoveryCodePepper {
  keyId: string
  /** A 32-byte secret. Strings must be unpadded base64url Worker secrets. */
  secret: string | Uint8Array
}

function recoveryPepperBytes(pepper: RecoveryCodePepper): Uint8Array {
  requireString(pepper.keyId, 'recovery pepper key id', { max: 128, pattern: /^[A-Za-z0-9._:-]+$/ })
  const bytes = typeof pepper.secret === 'string' ? base64urlDecode(pepper.secret, 64) : pepper.secret
  if (bytes.length < 32) throw new TotpError('Recovery-code pepper must contain at least 32 bytes', 'weak_recovery_pepper')
  return bytes
}

async function recoveryMac(code: string, userId: string, pepper: RecoveryCodePepper): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    recoveryPepperBytes(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const input = utf8(`OD1-RECOVERY|${requireString(userId, 'userId', { max: 128 })}|${normalizeRecoveryCode(code)}`)
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, input)))
}

export async function hashRecoveryCode(code: string, userId: string, pepper: RecoveryCodePepper): Promise<string> {
  return `${RECOVERY_HASH_VERSION}$k=${pepper.keyId}$${await recoveryMac(code, userId, pepper)}`
}

export async function hashRecoveryCodes(
  codes: readonly string[],
  userId: string,
  pepper: RecoveryCodePepper,
): Promise<string[]> {
  return Promise.all(codes.map((code) => hashRecoveryCode(code, userId, pepper)))
}

export async function verifyRecoveryCode(
  code: string,
  storedHash: string,
  userId: string,
  pepper: RecoveryCodePepper,
): Promise<boolean> {
  const match = /^OD-RECOVERY-HMAC-1\$k=([A-Za-z0-9._:-]{1,128})\$([0-9a-f]{64})$/.exec(storedHash)
  if (!match || match[1] !== pepper.keyId) return false
  let actual: string
  try {
    actual = await recoveryMac(code, userId, pepper)
  } catch (error) {
    if (error instanceof TotpError && error.code === 'invalid_recovery_code') return false
    throw error
  }
  return timingSafeEqual(utf8(actual), utf8(match[2]))
}
