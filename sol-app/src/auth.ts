import type { RuntimeEnvironment } from './validation'
import {
  base64urlDecode,
  base64urlEncode,
  bytesToHex,
  decodeUtf8,
  hexToBytes,
  randomBytes,
  requireInteger,
  requirePlainRecord,
  requireString,
  timingSafeEqual,
  utf8,
  validateUsername,
} from './validation'

export type UserRole = 'supplier' | 'verifier'
export type EntitlementKind = 'writer_plan' | 'read_pass'

export const SESSION_ISSUER = 'urn:outside-docker:session'
export const SESSION_AUDIENCE = 'outside-docker-web'
export const SESSION_TOKEN_VERSION = 1
export const DEFAULT_SESSION_TTL_SECONDS = 28 * 24 * 60 * 60

const PASSWORD_ALGORITHM = 'pbkdf2-sha256'
const PASSWORD_MAX_ITERATIONS = 1_000_000
const DUMMY_PASSWORD_HASH = `${PASSWORD_ALGORITHM}$v=2$i=100000$${'00'.repeat(32)}$${'00'.repeat(32)}`
const SESSION_HEADER_TYPE = 'od-session+jwt'
const SESSION_ALLOWED_HEADER_KEYS = ['alg', 'kid', 'typ'] as const
const SESSION_ALLOWED_CLAIM_KEYS = [
  'aud',
  'environment',
  'exp',
  'iat',
  'iss',
  'jti',
  'nbf',
  'role',
  'session_version',
  'sub',
  'type',
  'username',
  'version',
] as const

export interface PasswordHashPolicy {
  version: number
  iterations: number
  saltBytes: number
  digestBytes: number
}

export const DEFAULT_PASSWORD_HASH_POLICY: Readonly<PasswordHashPolicy> = Object.freeze({
  version: 2,
  // The Workers runtime used by this project accepts this PBKDF2 work factor.
  iterations: 100_000,
  saltBytes: 32,
  digestBytes: 32,
})

export interface ParsedPasswordHash {
  algorithm: typeof PASSWORD_ALGORITHM
  version: number
  iterations: number
  salt: Uint8Array
  digest: Uint8Array
}

export interface PasswordVerificationResult {
  valid: boolean
  needsUpgrade: boolean
  parsed: ParsedPasswordHash | null
  replacementHash?: string
}

function assertPasswordPolicy(policy: PasswordHashPolicy): void {
  requireInteger(policy.version, 'password hash version', 1, 99)
  requireInteger(policy.iterations, 'PBKDF2 iterations', 10_000, PASSWORD_MAX_ITERATIONS)
  requireInteger(policy.saltBytes, 'password salt bytes', 16, 64)
  requireInteger(policy.digestBytes, 'password digest bytes', 32, 64)
}

export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  if (typeof stored !== 'string' || stored.length > 1024) return null
  const parts = stored.split('$')
  if (parts.length !== 5 || parts[0] !== PASSWORD_ALGORITHM) return null
  const versionMatch = /^v=([1-9]\d?)$/.exec(parts[1])
  const iterationMatch = /^i=([1-9]\d{3,6})$/.exec(parts[2])
  if (!versionMatch || !iterationMatch) return null
  const version = Number(versionMatch[1])
  const iterations = Number(iterationMatch[1])
  if (!Number.isSafeInteger(iterations) || iterations > PASSWORD_MAX_ITERATIONS) return null
  try {
    const salt = hexToBytes(parts[3])
    const digest = hexToBytes(parts[4])
    if (salt.length < 16 || salt.length > 64 || digest.length < 32 || digest.length > 64) return null
    return { algorithm: PASSWORD_ALGORITHM, version, iterations, salt, digest }
  } catch {
    return null
  }
}

async function derivePasswordDigest(
  password: string,
  salt: Uint8Array,
  iterations: number,
  digestBytes: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits'])
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations, salt },
    material,
    digestBytes * 8,
  )
  return new Uint8Array(derived)
}

export async function hashPassword(
  password: string,
  policy: PasswordHashPolicy = DEFAULT_PASSWORD_HASH_POLICY,
): Promise<string> {
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024) {
    throw new AuthenticationError('Password is invalid', 400, 'invalid_password')
  }
  assertPasswordPolicy(policy)
  const salt = randomBytes(policy.saltBytes)
  const digest = await derivePasswordDigest(password, salt, policy.iterations, policy.digestBytes)
  return `${PASSWORD_ALGORITHM}$v=${policy.version}$i=${policy.iterations}$${bytesToHex(salt)}$${bytesToHex(digest)}`
}

export async function verifyPasswordHash(
  password: string,
  stored: string,
  policy: PasswordHashPolicy = DEFAULT_PASSWORD_HASH_POLICY,
): Promise<PasswordVerificationResult> {
  assertPasswordPolicy(policy)
  const parsed = parsePasswordHash(stored)
  if (!parsed || typeof password !== 'string' || password.length > 1024) {
    return { valid: false, needsUpgrade: false, parsed }
  }
  // A future format version must be handled by future code, never guessed at.
  if (parsed.version > policy.version) return { valid: false, needsUpgrade: false, parsed }
  const actual = await derivePasswordDigest(password, parsed.salt, parsed.iterations, parsed.digest.length)
  const valid = timingSafeEqual(actual, parsed.digest)
  const needsUpgrade = valid && (
    parsed.version !== policy.version
    || parsed.iterations !== policy.iterations
    || parsed.salt.length !== policy.saltBytes
    || parsed.digest.length !== policy.digestBytes
  )
  return { valid, needsUpgrade, parsed }
}

/** Verify a legacy/current hash and return a replacement only after a valid login. */
export async function verifyAndUpgradePasswordHash(
  password: string,
  stored: string,
  policy: PasswordHashPolicy = DEFAULT_PASSWORD_HASH_POLICY,
): Promise<PasswordVerificationResult> {
  const result = await verifyPasswordHash(password, stored, policy)
  if (!result.needsUpgrade) return result
  return { ...result, replacementHash: await hashPassword(password, policy) }
}

/**
 * Login-safe wrapper: a missing account still performs the current PBKDF2 work,
 * reducing username-existence leakage through response timing.
 */
export async function verifyLoginPassword(
  password: string,
  stored: string | null | undefined,
  policy: PasswordHashPolicy = DEFAULT_PASSWORD_HASH_POLICY,
): Promise<PasswordVerificationResult> {
  const result = await verifyAndUpgradePasswordHash(password, stored ?? DUMMY_PASSWORD_HASH, policy)
  return stored ? result : { valid: false, needsUpgrade: false, parsed: null }
}

export interface SessionClaimsV1 {
  iss: string
  aud: string
  sub: string
  username: string
  role: UserRole
  type: 'session'
  version: typeof SESSION_TOKEN_VERSION
  environment: RuntimeEnvironment
  session_version: number
  jti: string
  iat: number
  nbf: number
  exp: number
}

export interface SessionTokenConfig {
  secret: string | Uint8Array
  environment: RuntimeEnvironment
  issuer?: string
  audience?: string
  keyId?: string
  ttlSeconds?: number
  clockSkewSeconds?: number
  now?: () => number
}

export interface IssueSessionInput {
  userId: string
  username: string
  role: UserRole
  sessionVersion: number
  tokenId?: string
}

export type SessionFailureReason =
  | 'malformed'
  | 'unsupported_header'
  | 'invalid_signature'
  | 'invalid_claims'
  | 'wrong_environment'
  | 'not_yet_valid'
  | 'expired'
  | 'invalid_lifetime'

export type SessionVerification =
  | { valid: true; claims: SessionClaimsV1 }
  | { valid: false; reason: SessionFailureReason }

function sessionSecretBytes(secret: string | Uint8Array): Uint8Array {
  const output = typeof secret === 'string' ? utf8(secret) : secret
  if (output.length < 32) throw new AuthenticationError('Session secret must contain at least 32 bytes', 500, 'weak_session_secret')
  return output
}

function sessionKeyId(config: SessionTokenConfig): string {
  return config.keyId ?? `od-session-${config.environment}-v1`
}

function nowSeconds(config: SessionTokenConfig): number {
  return Math.floor((config.now?.() ?? Date.now()) / 1000)
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record).sort()
  const expected = [...allowed].sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

async function hmacSha256(secret: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, input))
}

export async function issueSessionToken(input: IssueSessionInput, config: SessionTokenConfig): Promise<string> {
  const secret = sessionSecretBytes(config.secret)
  const username = validateUsername(input.username)
  const sub = requireString(input.userId, 'userId', { max: 128 })
  if (input.role !== 'supplier' && input.role !== 'verifier') {
    throw new AuthenticationError('Invalid user role', 500, 'invalid_role')
  }
  const sessionVersion = requireInteger(input.sessionVersion, 'sessionVersion', 1, 2_147_483_647)
  const ttl = requireInteger(config.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS, 'session ttl', 60, DEFAULT_SESSION_TTL_SECONDS)
  const issuedAt = nowSeconds(config)
  const tokenId = input.tokenId ?? base64urlEncode(randomBytes(18))
  requireString(tokenId, 'tokenId', { min: 16, max: 128, pattern: /^[A-Za-z0-9_-]+$/ })
  const header = { alg: 'HS256', kid: sessionKeyId(config), typ: SESSION_HEADER_TYPE }
  const claims: SessionClaimsV1 = {
    iss: config.issuer ?? SESSION_ISSUER,
    aud: config.audience ?? SESSION_AUDIENCE,
    sub,
    username,
    role: input.role,
    type: 'session',
    version: SESSION_TOKEN_VERSION,
    environment: config.environment,
    session_version: sessionVersion,
    jti: tokenId,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + ttl,
  }
  const encodedHeader = base64urlEncode(JSON.stringify(header))
  const encodedClaims = base64urlEncode(JSON.stringify(claims))
  const signingInput = `${encodedHeader}.${encodedClaims}`
  const signature = await hmacSha256(secret, utf8(signingInput))
  return `${signingInput}.${base64urlEncode(signature)}`
}

function invalidSession(reason: SessionFailureReason): SessionVerification {
  return { valid: false, reason }
}

export async function verifySessionTokenDetailed(token: string, config: SessionTokenConfig): Promise<SessionVerification> {
  if (typeof token !== 'string' || token.length < 64 || token.length > 4096) return invalidSession('malformed')
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) return invalidSession('malformed')
  let header: Record<string, unknown>
  try {
    header = requirePlainRecord(JSON.parse(decodeUtf8(base64urlDecode(parts[0], 1024))))
  } catch {
    return invalidSession('malformed')
  }
  if (
    !exactKeys(header, SESSION_ALLOWED_HEADER_KEYS)
    || header.alg !== 'HS256'
    || header.typ !== SESSION_HEADER_TYPE
    || header.kid !== sessionKeyId(config)
  ) return invalidSession('unsupported_header')

  let signature: Uint8Array
  try {
    signature = base64urlDecode(parts[2], 64)
  } catch {
    return invalidSession('malformed')
  }
  const expected = await hmacSha256(sessionSecretBytes(config.secret), utf8(`${parts[0]}.${parts[1]}`))
  if (!timingSafeEqual(signature, expected)) return invalidSession('invalid_signature')

  let raw: Record<string, unknown>
  try {
    raw = requirePlainRecord(JSON.parse(decodeUtf8(base64urlDecode(parts[1], 4096))))
  } catch {
    return invalidSession('invalid_claims')
  }
  if (!exactKeys(raw, SESSION_ALLOWED_CLAIM_KEYS)) return invalidSession('invalid_claims')
  if (
    raw.iss !== (config.issuer ?? SESSION_ISSUER)
    || raw.aud !== (config.audience ?? SESSION_AUDIENCE)
    || raw.type !== 'session'
    || raw.version !== SESSION_TOKEN_VERSION
    || (raw.role !== 'supplier' && raw.role !== 'verifier')
    || typeof raw.sub !== 'string'
    || raw.sub.length < 1
    || raw.sub.length > 128
    || typeof raw.username !== 'string'
    || validateUsernameSafely(raw.username) !== raw.username
    || typeof raw.jti !== 'string'
    || !/^[A-Za-z0-9_-]{16,128}$/.test(raw.jti)
    || !Number.isSafeInteger(raw.session_version)
    || (raw.session_version as number) < 1
    || !Number.isSafeInteger(raw.iat)
    || !Number.isSafeInteger(raw.nbf)
    || !Number.isSafeInteger(raw.exp)
  ) return invalidSession('invalid_claims')
  if (raw.environment !== config.environment) return invalidSession('wrong_environment')

  const current = nowSeconds(config)
  const skew = requireInteger(config.clockSkewSeconds ?? 30, 'clock skew', 0, 300)
  const maximumLifetime = requireInteger(
    config.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
    'session ttl',
    60,
    DEFAULT_SESSION_TTL_SECONDS,
  )
  const issuedAt = raw.iat as number
  const notBefore = raw.nbf as number
  const expiresAt = raw.exp as number
  if (notBefore > current + skew || issuedAt > current + skew) return invalidSession('not_yet_valid')
  if (expiresAt <= current - skew) return invalidSession('expired')
  if (notBefore !== issuedAt || expiresAt <= issuedAt || expiresAt - issuedAt > maximumLifetime) {
    return invalidSession('invalid_lifetime')
  }
  return { valid: true, claims: raw as unknown as SessionClaimsV1 }
}

function validateUsernameSafely(value: string): string | null {
  try {
    return validateUsername(value)
  } catch {
    return null
  }
}

export async function verifySessionToken(token: string, config: SessionTokenConfig): Promise<SessionClaimsV1 | null> {
  const result = await verifySessionTokenDetailed(token, config)
  return result.valid ? result.claims : null
}

export interface CurrentUser {
  id: string
  username: string
  role: UserRole
  active: boolean
  disabledAt: string | null
  sessionVersion: number
  totpEnabled: boolean
  totpRequired: boolean
}

export interface ActiveEntitlement {
  id: string
  userId: string
  kind: EntitlementKind
  scopeId: string | null
  planCode: string | null
  status: string
  validFrom: string
  validUntil: string
  autoRenew: boolean
}

export interface CurrentUserReader {
  findCurrentUser(userId: string): Promise<CurrentUser | null>
}

export interface EntitlementReader {
  listEntitlements(userId: string): Promise<ActiveEntitlement[]>
}

export interface AuthenticatedUser {
  claims: SessionClaimsV1
  user: CurrentUser
}

export interface EntitlementRequirement {
  kind: EntitlementKind
  scopeId?: string | null
  statuses?: readonly string[]
  denialStatus?: 402 | 403
}

export interface AuthorizationRequirements {
  roles?: readonly UserRole[]
  entitlement?: EntitlementRequirement
}

export interface AuthorizedUser extends AuthenticatedUser {
  entitlement?: ActiveEntitlement
}

export class AuthenticationError extends Error {
  readonly status: number
  readonly code: string

  constructor(message = 'Authentication required', status = 401, code = 'authentication_required') {
    super(message)
    this.name = 'AuthenticationError'
    this.status = status
    this.code = code
  }
}

export class AuthorizationError extends Error {
  readonly status: 402 | 403
  readonly code: string

  constructor(message = 'Forbidden', status: 402 | 403 = 403, code = 'forbidden') {
    super(message)
    this.name = 'AuthorizationError'
    this.status = status
    this.code = code
  }
}

export async function authenticateCurrentUser(
  token: string | null | undefined,
  config: SessionTokenConfig,
  reader: CurrentUserReader,
): Promise<AuthenticatedUser> {
  if (!token) throw new AuthenticationError()
  const claims = await verifySessionToken(token, config)
  if (!claims) throw new AuthenticationError()
  const user = await reader.findCurrentUser(claims.sub)
  if (
    !user
    || !user.active
    || user.disabledAt !== null
    || user.sessionVersion !== claims.session_version
    || user.role !== claims.role
    || user.username !== claims.username
  ) throw new AuthenticationError('Session is no longer valid', 401, 'session_revoked')
  return { claims, user }
}

export function requireRole(user: CurrentUser, roles: readonly UserRole[]): void {
  if (!roles.includes(user.role)) throw new AuthorizationError('This role cannot perform that operation', 403, 'role_forbidden')
}

function databaseTimestamp(value: string): number {
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/u.test(value) ? value : `${value.replace(' ', 'T')}Z`
  return Date.parse(normalized)
}

export async function requireActiveEntitlement(
  user: CurrentUser,
  requirement: EntitlementRequirement,
  reader: EntitlementReader,
  now = new Date(),
): Promise<ActiveEntitlement> {
  const statuses = requirement.statuses ?? ['active', 'trialing']
  const instant = now.getTime()
  const entitlements = await reader.listEntitlements(user.id)
  const entitlement = entitlements.find((candidate) => {
    if (candidate.kind !== requirement.kind || !statuses.includes(candidate.status)) return false
    if (requirement.scopeId !== undefined && candidate.scopeId !== requirement.scopeId) return false
    const from = databaseTimestamp(candidate.validFrom)
    const until = databaseTimestamp(candidate.validUntil)
    return Number.isFinite(from) && Number.isFinite(until) && from <= instant && instant < until
  })
  if (!entitlement) {
    throw new AuthorizationError(
      requirement.kind === 'writer_plan' ? 'An active supplier plan is required' : 'An active Read Pass is required',
      requirement.denialStatus ?? (requirement.kind === 'writer_plan' ? 402 : 403),
      'entitlement_required',
    )
  }
  return entitlement
}

export async function authorizeCurrentUser(
  authenticated: AuthenticatedUser,
  requirements: AuthorizationRequirements,
  entitlementReader?: EntitlementReader,
  now?: Date,
): Promise<AuthorizedUser> {
  if (requirements.roles) requireRole(authenticated.user, requirements.roles)
  if (!requirements.entitlement) return authenticated
  if (!entitlementReader) throw new AuthenticationError('Entitlement reader is not configured', 500, 'configuration_error')
  const entitlement = await requireActiveEntitlement(authenticated.user, requirements.entitlement, entitlementReader, now)
  return { ...authenticated, entitlement }
}

export async function guardCurrentUser(
  token: string | null | undefined,
  config: SessionTokenConfig,
  reader: CurrentUserReader & EntitlementReader,
  requirements: AuthorizationRequirements = {},
  now?: Date,
): Promise<AuthorizedUser> {
  const authenticated = await authenticateCurrentUser(token, config, reader)
  return authorizeCurrentUser(authenticated, requirements, reader, now)
}

export interface D1ResultLike<T = unknown> {
  results?: T[]
  success?: boolean
  meta?: { changes?: number }
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike
}

interface D1UserRow {
  id: string
  username: string
  role: UserRole
  is_active: number
  disabled_at: string | null
  session_version: number
  totp_enabled: number
  totp_required: number
}

interface D1EntitlementRow {
  id: string
  user_id: string
  kind: EntitlementKind
  scope_id: string | null
  plan_code: string | null
  status: string
  valid_from: string
  valid_until: string
  auto_renew: number
}

/** D1 adapter for the Phase 1 migration; each guard call executes fresh queries. */
export function createD1AuthorizationReader(database: D1DatabaseLike): CurrentUserReader & EntitlementReader {
  return {
    async findCurrentUser(userId) {
      const row = await database.prepare(`
        SELECT id, username, role, is_active, disabled_at, session_version,
               totp_enabled, totp_required
        FROM users WHERE id = ? LIMIT 1
      `).bind(userId).first<D1UserRow>()
      if (!row) return null
      return {
        id: row.id,
        username: row.username,
        role: row.role,
        active: row.is_active === 1,
        disabledAt: row.disabled_at,
        sessionVersion: row.session_version,
        totpEnabled: row.totp_enabled === 1,
        totpRequired: row.totp_required === 1,
      }
    },
    async listEntitlements(userId) {
      const response = await database.prepare(`
        SELECT id, user_id, kind, scope_id, plan_code, status, valid_from, valid_until, auto_renew
        FROM entitlements WHERE user_id = ?
      `).bind(userId).all<D1EntitlementRow>()
      return (response.results ?? []).map((row) => ({
        id: row.id,
        userId: row.user_id,
        kind: row.kind,
        scopeId: row.scope_id,
        planCode: row.plan_code,
        status: row.status,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        autoRenew: row.auto_renew === 1,
      }))
    },
  }
}

export interface HeadersLike {
  get(name: string): string | null
}

export interface RequestLike {
  method: string
  headers: HeadersLike
}

export class RequestSecurityError extends Error {
  readonly status = 403
  readonly code: string

  constructor(message: string, code = 'request_rejected') {
    super(message)
    this.name = 'RequestSecurityError'
    this.code = code
  }
}

function normalizedOrigin(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('invalid scheme')
    return parsed.origin
  } catch {
    throw new RequestSecurityError('Request origin is invalid', 'invalid_origin')
  }
}

export function assertAllowedOrigin(
  request: RequestLike,
  allowedOrigins: readonly string[],
  options: { allowMissing?: boolean } = {},
): void {
  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase()
  if (fetchSite === 'cross-site') throw new RequestSecurityError('Cross-site request rejected', 'cross_site_request')
  const header = request.headers.get('origin')
  const referer = request.headers.get('referer')
  if (!header && !referer) {
    if (options.allowMissing) return
    throw new RequestSecurityError('Origin header is required', 'missing_origin')
  }
  const actual = normalizedOrigin(header ?? (referer as string))
  const allowed = allowedOrigins.map(normalizedOrigin)
  if (!allowed.includes(actual)) throw new RequestSecurityError('Origin is not allowed', 'origin_not_allowed')
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>()
  if (!header) return cookies
  for (const item of header.split(';')) {
    const separator = item.indexOf('=')
    if (separator <= 0) continue
    const name = item.slice(0, separator).trim()
    const value = item.slice(separator + 1).trim()
    if (name && !cookies.has(name)) cookies.set(name, value)
  }
  return cookies
}

function csrfSecretBytes(secret: string | Uint8Array): Uint8Array {
  const output = typeof secret === 'string' ? utf8(secret) : secret
  if (output.length < 32) throw new RequestSecurityError('CSRF secret must contain at least 32 bytes', 'weak_csrf_secret')
  return output
}

export async function issueCsrfToken(secret: string | Uint8Array, sessionId: string): Promise<string> {
  requireString(sessionId, 'sessionId', { min: 16, max: 128 })
  const nonce = base64urlEncode(randomBytes(24))
  const mac = await hmacSha256(csrfSecretBytes(secret), utf8(`OD1-CSRF|v1|${sessionId}|${nonce}`))
  return `v1.${nonce}.${base64urlEncode(mac)}`
}

export async function verifyCsrfToken(token: string, secret: string | Uint8Array, sessionId: string): Promise<boolean> {
  if (typeof token !== 'string' || token.length > 256) return false
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]{32}$/.test(parts[1])) return false
  let supplied: Uint8Array
  try {
    supplied = base64urlDecode(parts[2], 64)
  } catch {
    return false
  }
  const expected = await hmacSha256(csrfSecretBytes(secret), utf8(`OD1-CSRF|v1|${sessionId}|${parts[1]}`))
  return timingSafeEqual(supplied, expected)
}

export interface CsrfProtectionOptions {
  allowedOrigins: readonly string[]
  secret: string | Uint8Array
  sessionId: string
  cookieName?: string
  headerName?: string
}

export async function assertCsrfProtection(request: RequestLike, options: CsrfProtectionOptions): Promise<void> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return
  assertAllowedOrigin(request, options.allowedOrigins)
  const cookieName = options.cookieName ?? 'od_csrf'
  const headerName = options.headerName ?? 'x-csrf-token'
  const cookieToken = parseCookies(request.headers.get('cookie')).get(cookieName)
  const headerToken = request.headers.get(headerName)
  if (!cookieToken || !headerToken) throw new RequestSecurityError('CSRF token is required', 'csrf_required')
  if (!timingSafeEqual(utf8(cookieToken), utf8(headerToken))) {
    throw new RequestSecurityError('CSRF token does not match', 'csrf_mismatch')
  }
  if (!(await verifyCsrfToken(headerToken, options.secret, options.sessionId))) {
    throw new RequestSecurityError('CSRF token is invalid', 'csrf_invalid')
  }
}
