const encoder = new TextEncoder()
import { canonicalize } from './canonical'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

export type RuntimeEnvironment = 'dev' | 'prod'
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export class ValidationError extends Error {
  readonly code: string
  readonly field?: string

  constructor(message: string, code = 'invalid_value', field?: string) {
    super(message)
    this.name = 'ValidationError'
    this.code = code
    this.field = field
  }
}

export const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/
export const RECOVERY_EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(gmail|hotmail)\.com$/
export const HEX_256_PATTERN = /^[0-9a-f]{64}$/

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase()
}

export function validateUsername(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('Username is required', 'required', 'username')
  const normalized = normalizeUsername(value)
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new ValidationError('Username must be 3-32 lowercase letters, numbers, _ or -', 'invalid_username', 'username')
  }
  return normalized
}

export interface PasswordValidationResult {
  valid: boolean
  issues: string[]
}

export function inspectPassword(value: unknown): PasswordValidationResult {
  const issues: string[] = []
  if (typeof value !== 'string') return { valid: false, issues: ['required'] }
  if (value.length < 7) issues.push('minimum_length')
  if (value.length > 18) issues.push('maximum_length')
  if (!/[A-Za-z]/.test(value)) issues.push('letter')
  if (!/\d/.test(value)) issues.push('digit')
  return { valid: issues.length === 0, issues }
}

export function validatePassword(value: unknown): string {
  const inspected = inspectPassword(value)
  if (!inspected.valid) {
    throw new ValidationError(
      'Password requires 7-18 characters including at least one letter and one digit',
      'weak_password',
      'password',
    )
  }
  return value as string
}

export function normalizeOptionalGmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError('Email must be a string', 'invalid_email', 'email')
  const normalized = value.trim().toLowerCase()
  if (normalized.length > 254 || !RECOVERY_EMAIL_PATTERN.test(normalized)) {
    throw new ValidationError('Recovery email must use Gmail or Hotmail', 'invalid_email', 'email')
  }
  return normalized
}

export function assertEnvironment(value: unknown): asserts value is RuntimeEnvironment {
  if (value !== 'dev' && value !== 'prod') throw new ValidationError('Environment must be dev or prod', 'invalid_environment')
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function requirePlainRecord(value: unknown, field?: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new ValidationError(`${field ?? 'Value'} must be an object`, 'invalid_object', field)
  return value
}

export function requireString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {},
): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, 'invalid_string', field)
  const output = options.trim === false ? value : value.trim()
  const min = options.min ?? 1
  const max = options.max ?? 4096
  if (output.length < min || output.length > max || (options.pattern && !options.pattern.test(output))) {
    throw new ValidationError(`${field} is invalid`, 'invalid_string', field)
  }
  return output
}

export function requireInteger(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}`, 'invalid_integer', field)
  }
  return value as number
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}

export function decodeUtf8(value: Uint8Array): string {
  try {
    return decoder.decode(value)
  } catch {
    throw new ValidationError('Invalid UTF-8', 'invalid_utf8')
  }
}

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(value: string, expectedBytes?: number): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) throw new ValidationError('Invalid hexadecimal value', 'invalid_hex')
  if (expectedBytes !== undefined && value.length !== expectedBytes * 2) {
    throw new ValidationError(`Expected ${expectedBytes} bytes`, 'invalid_length')
  }
  const output = new Uint8Array(value.length / 2)
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return output
}

function bytesToBinary(value: Uint8Array): string {
  let output = ''
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    output += String.fromCharCode(...value.subarray(offset, offset + 0x8000))
  }
  return output
}

export function base64urlEncode(value: Uint8Array | string): string {
  const binary = typeof value === 'string' ? bytesToBinary(utf8(value)) : bytesToBinary(value)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function base64urlDecode(value: string, maximumBytes = 1_048_576): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new ValidationError('Invalid base64url value', 'invalid_base64url')
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new ValidationError('Invalid base64url value', 'invalid_base64url')
  }
  if (binary.length > maximumBytes) throw new ValidationError('Decoded value is too large', 'maximum_length')
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) {
    throw new ValidationError('Invalid random byte length', 'invalid_length')
  }
  const output = new Uint8Array(length)
  for (let offset = 0; offset < output.length; offset += 65_536) {
    crypto.getRandomValues(output.subarray(offset, Math.min(offset + 65_536, output.length)))
  }
  return output
}

/** Compatibility wrapper around the application's single canonical serializer. */
export function canonicalJson(value: JsonValue | unknown): string {
  return canonicalize(value)
}

export async function sha256Bytes(value: Uint8Array | string): Promise<Uint8Array> {
  const input = typeof value === 'string' ? utf8(value) : value
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input))
}

export async function sha256Hex(value: Uint8Array | string): Promise<string> {
  return bytesToHex(await sha256Bytes(value))
}

export function safeErrorMessage(error: unknown, fallback = 'Operation failed'): string {
  if (!(error instanceof Error)) return fallback
  return error.message
    .replace(/[\r\n\t]/gu, ' ')
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+\b/gu, '[redacted-stripe-key]')
    .replace(/\bwhsec_[A-Za-z0-9_]+\b/gu, '[redacted-webhook-secret]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .slice(0, 500) || fallback
}
