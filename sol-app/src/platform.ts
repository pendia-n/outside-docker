import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  AuthenticationError,
  AuthorizationError,
  assertAllowedOrigin,
  assertCsrfProtection,
  authenticateCurrentUser,
  createD1AuthorizationReader,
  issueCsrfToken,
  issueSessionToken,
  type ActiveEntitlement,
  type AuthenticatedUser,
  type SessionClaimsV1,
} from './auth'
import { databaseFor } from './db'
import type { Env, SupplierMode, Track } from './types'
import { base64urlEncode, randomBytes, sha256Hex } from './validation'

export type AppContext = Context<{ Bindings: Env }>

export interface SessionActor extends AuthenticatedUser {
  claims: SessionClaimsV1
  sessionId: string
  tokenHash: string
  email: string | null
  supplierMode: SupplierMode | null
  entitlements: ActiveEntitlement[]
}

const SESSION_COOKIE = 'od_session'
const CSRF_COOKIE = 'od_csrf'
const SESSION_SECONDS = 28 * 24 * 60 * 60

export function requestDatabase(context: Pick<AppContext, 'env'>): D1Database {
  return databaseFor(context.env)
}

function sessionConfig(environment: Env) {
  if (!environment.JWT_SECRET) throw new AuthenticationError('Session signing is not configured', 500, 'configuration_error')
  return {
    secret: environment.JWT_SECRET,
    environment: environment.ENV,
    ttlSeconds: SESSION_SECONDS,
  } as const
}

function csrfSecret(environment: Env): string {
  return environment.CSRF_SECRET || environment.JWT_SECRET
}

function secureCookie(context: AppContext): boolean {
  return context.env.ENV === 'prod' || new URL(context.req.url).protocol === 'https:'
}

export function clearAuthenticationCookies(context: AppContext): void {
  deleteCookie(context, SESSION_COOKIE, { path: '/' })
  deleteCookie(context, CSRF_COOKIE, { path: '/' })
}

export async function createBrowserSession(
  context: AppContext,
  user: { id: string; username: string; role: 'supplier' | 'verifier'; sessionVersion: number },
): Promise<{ token: string; csrfToken: string; sessionId: string }> {
  const sessionId = base64urlEncode(randomBytes(18))
  const token = await issueSessionToken({
    userId: user.id,
    username: user.username,
    role: user.role,
    sessionVersion: user.sessionVersion,
    tokenId: sessionId,
  }, sessionConfig(context.env))
  const tokenHash = await sha256Hex(token)
  const now = new Date()
  const expiresAt = new Date(now.valueOf() + SESSION_SECONDS * 1000).toISOString()
  const ip = context.req.header('CF-Connecting-IP') || ''
  const userAgent = context.req.header('User-Agent') || ''
  await requestDatabase(context).prepare(`
    INSERT INTO auth_sessions (
      id, user_id, token_hash, session_version, expires_at, revoked_at,
      last_seen_at, ip_hash, user_agent_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).bind(
    sessionId,
    user.id,
    tokenHash,
    user.sessionVersion,
    expiresAt,
    now.toISOString(),
    ip ? await sha256Hex(`OD1|SESSION-IP|${csrfSecret(context.env)}|${ip}`) : null,
    userAgent ? await sha256Hex(`OD1|SESSION-UA|${userAgent}`) : null,
    now.toISOString(),
  ).run()
  const csrfToken = await issueCsrfToken(csrfSecret(context.env), sessionId)
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookie(context),
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_SECONDS,
  })
  setCookie(context, CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: secureCookie(context),
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_SECONDS,
  })
  return { token, csrfToken, sessionId }
}

export async function currentSession(context: AppContext): Promise<SessionActor> {
  const token = getCookie(context, SESSION_COOKIE)
  const database = requestDatabase(context)
  const reader = createD1AuthorizationReader(database)
  const authenticated = await authenticateCurrentUser(token, sessionConfig(context.env), reader)
  const tokenHash = await sha256Hex(token as string)
  const activeSession = await database.prepare(`
    SELECT id FROM auth_sessions
    WHERE id = ? AND user_id = ? AND token_hash = ? AND session_version = ?
      AND revoked_at IS NULL AND expires_at > ? LIMIT 1
  `).bind(
    authenticated.claims.jti,
    authenticated.user.id,
    tokenHash,
    authenticated.claims.session_version,
    new Date().toISOString(),
  ).first<{ id: string }>()
  if (!activeSession) throw new AuthenticationError('Session is no longer valid', 401, 'session_revoked')
  const profile = await database.prepare(`
    SELECT u.email_normalized, o.initial_mode
    FROM users u LEFT JOIN organizations o ON o.user_id = u.id
    WHERE u.id = ? LIMIT 1
  `).bind(authenticated.user.id).first<{ email_normalized: string | null; initial_mode: SupplierMode | 'HM' | null }>()
  const supplierMode = profile?.initial_mode === 'HM' ? 'both' : profile?.initial_mode ?? null
  return {
    ...authenticated,
    sessionId: activeSession.id,
    tokenHash,
    email: profile?.email_normalized ?? null,
    supplierMode,
    entitlements: await reader.listEntitlements(authenticated.user.id),
  }
}

export async function optionalSession(context: AppContext): Promise<SessionActor | null> {
  try {
    return await currentSession(context)
  } catch (error) {
    if (error instanceof AuthenticationError) return null
    throw error
  }
}

function databaseTime(value: string): number {
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/u.test(value) ? value : `${value.replace(' ', 'T')}Z`)
}

export function activeEntitlement(
  actor: SessionActor,
  kind: 'writer_plan' | 'read_pass',
  scopeId?: string,
  now = Date.now(),
): ActiveEntitlement | null {
  return actor.entitlements.find((entitlement) => {
    if (entitlement.kind !== kind || !['active', 'trialing'].includes(entitlement.status)) return false
    if (scopeId !== undefined && entitlement.scopeId !== scopeId) return false
    return databaseTime(entitlement.validFrom) <= now && now < databaseTime(entitlement.validUntil)
  }) ?? null
}

export function requireSupplierMode(actor: SessionActor, track: Track): void {
  if (actor.user.role !== 'supplier') throw new AuthorizationError('Supplier access required', 403, 'supplier_required')
  if (actor.supplierMode !== track && actor.supplierMode !== 'both') {
    throw new AuthorizationError(`Track ${track} is not enabled for this supplier`, 403, 'track_not_enabled')
  }
  if (!activeEntitlement(actor, 'writer_plan')) {
    throw new AuthorizationError('An active supplier plan is required', 402, 'entitlement_required')
  }
}

export function requireVerifierScope(actor: SessionActor, scopeId: string): void {
  if (actor.user.role !== 'verifier') throw new AuthorizationError('Verifier access required', 403, 'verifier_required')
  if (!activeEntitlement(actor, 'read_pass', scopeId)) {
    throw new AuthorizationError('An active Read Pass is required for this scope', 403, 'read_pass_required')
  }
}

export function allowedOrigins(context: AppContext): string[] {
  const configured = context.env.APP_ORIGIN || new URL(context.req.url).origin
  if (context.env.ENV !== 'dev') return [configured]
  const requestOrigin = new URL(context.req.url).origin
  return requestOrigin === configured ? [configured] : [configured, requestOrigin]
}

export function assertPublicMutationOrigin(context: AppContext): void {
  assertAllowedOrigin(context.req.raw, allowedOrigins(context), { allowMissing: context.env.ENV === 'dev' })
}

export async function assertSessionMutation(context: AppContext, actor: SessionActor): Promise<void> {
  await assertCsrfProtection(context.req.raw, {
    allowedOrigins: allowedOrigins(context),
    secret: csrfSecret(context.env),
    sessionId: actor.sessionId,
  })
}

export async function refreshCsrf(context: AppContext, actor: SessionActor): Promise<string> {
  const token = await issueCsrfToken(csrfSecret(context.env), actor.sessionId)
  setCookie(context, CSRF_COOKIE, token, {
    httpOnly: false,
    secure: secureCookie(context),
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_SECONDS,
  })
  return token
}

export async function revokeSession(context: AppContext, actor: SessionActor): Promise<void> {
  await requestDatabase(context).prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND user_id = ?')
    .bind(new Date().toISOString(), actor.sessionId, actor.user.id).run()
  clearAuthenticationCookies(context)
}
