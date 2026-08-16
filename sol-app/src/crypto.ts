import type { SessionClaims } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const PBKDF2_ITERATIONS = 100_000

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function bytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function randomHex(length = 32): string {
  return hex(crypto.getRandomValues(new Uint8Array(length)))
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const input = typeof value === 'string' ? encoder.encode(value) : value
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)))
}

async function pbkdf2(password: string, saltHex: string): Promise<string> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: bytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, material, 256)
  return hex(new Uint8Array(bits))
}

export async function passwordHash(password: string): Promise<string> {
  const salt = randomHex(16)
  const digest = await pbkdf2(password, salt)
  return `pbkdf2-sha256$v=1$i=${PBKDF2_ITERATIONS}$${salt}$${digest}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 5 || parts[0] !== 'pbkdf2-sha256' || parts[1] !== 'v=1' || parts[2] !== `i=${PBKDF2_ITERATIONS}`) return false
  const salt = parts[3]
  const expected = parts[4]
  const actual = await pbkdf2(password, salt)
  return timingSafeEqual(actual, expected)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return result === 0
}

function b64url(value: string | Uint8Array): string {
  const binary = typeof value === 'string' ? String.fromCharCode(...encoder.encode(value)) : String.fromCharCode(...value)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function unb64url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

export async function signJwt(claims: SessionClaims, secret: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(claims))
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`)))
  return `${header}.${body}.${b64url(signature)}`
}

export async function verifyJwt(token: string, secret: string): Promise<SessionClaims | null> {
  try {
    const [header, body, signature] = token.split('.')
    if (!header || !body || !signature) return null
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify('HMAC', key, unb64url(signature), encoder.encode(`${header}.${body}`))
    if (!ok) return null
    const claims = JSON.parse(decoder.decode(unb64url(body))) as SessionClaims
    if (claims.type !== 'session' || claims.exp <= Math.floor(Date.now() / 1000)) return null
    return claims
  } catch {
    return null
  }
}

export async function contentCommitment(contentHash: string, secretSalt: string): Promise<string> {
  return sha256(`OD1-CONTENT-COMMITMENT|${secretSalt}|${contentHash}`)
}

export async function eventProof(commitment: string, previousProof: string | null, position: number, createdAt: string): Promise<string> {
  return sha256(`OD1-EVENT|${position}|${createdAt}|${commitment}|${previousProof ?? ''}`)
}
