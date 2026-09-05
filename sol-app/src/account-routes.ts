import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { toString as qrToString } from 'qrcode'
import { hashPassword, verifyLoginPassword } from './auth'
import { StripeRestClient, type SupplierPlanCode } from './billing'
import { newId } from './db'
import {
  assertPublicMutationOrigin,
  assertSessionMutation,
  clearAuthenticationCookies,
  createBrowserSession,
  currentSession,
  optionalSession,
  refreshCsrf,
  requestDatabase,
  requireSupplierMode,
  revokeSession,
  type SessionActor,
} from './platform'
import {
  confirmTotpEnrollment,
  createTotpEnrollment,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCodes,
  verifyRecoveryCode,
  verifyTotpCode,
  type RecoveryCodePepper,
  type TotpSecretEnvelope,
} from './totp'
import type { Env, SupplierMode } from './types'
import {
  ValidationError,
  normalizeOptionalGmail,
  requirePlainRecord,
  requireString,
  validatePassword,
  validateUsername,
} from './validation'

export class AccountError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AccountError'
  }
}

interface RegistrationInput {
  username?: unknown
  password?: unknown
  email?: unknown
  role?: unknown
  initial_mode?: unknown
  plan_code?: unknown
  organization?: unknown
  address_line1?: unknown
  address_line2?: unknown
  city?: unknown
  region?: unknown
  postal_code?: unknown
  country?: unknown
  scope_id?: unknown
  auto_renew?: unknown
}

interface ValidRegistration {
  username: string
  password: string
  email: string | null
  role: 'supplier' | 'verifier'
  initialMode: SupplierMode | null
  planCode: SupplierPlanCode | null
  organization: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  scopeId: string | null
  autoRenew: boolean
}

const PLAN_PRICES: Record<SupplierPlanCode, number> = { A: 9_900, B: 29_900, C: 79_900, D: 199_900 }

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return requireString(value, field, { max: maximum })
}

function validateRegistration(input: RegistrationInput): ValidRegistration {
  const username = validateUsername(input.username)
  const password = validatePassword(input.password)
  const email = normalizeOptionalGmail(input.email)
  const role = input.role ?? 'supplier'
  if (role !== 'supplier' && role !== 'verifier') {
    throw new ValidationError('Role must be supplier or verifier', 'invalid_role', 'role')
  }
  const supplier = role === 'supplier'
  let initialMode: SupplierMode | null = null
  let planCode: SupplierPlanCode | null = null
  if (supplier) {
    const rawMode = input.initial_mode === undefined ? 'H' : input.initial_mode === 'HM' ? 'both' : input.initial_mode
    if (rawMode !== 'H' && rawMode !== 'M' && rawMode !== 'both') {
      throw new ValidationError('Initial mode must be H, M, or both', 'invalid_mode', 'initial_mode')
    }
    if (input.plan_code !== undefined && input.plan_code !== 'A' && input.plan_code !== 'B' && input.plan_code !== 'C' && input.plan_code !== 'D') {
      throw new ValidationError('Supplier plan must be A, B, C, or D', 'invalid_plan', 'plan_code')
    }
    initialMode = rawMode
    planCode = input.plan_code ?? 'A'
  }
  return {
    username,
    password,
    email,
    role,
    initialMode,
    planCode,
    organization: supplier ? optionalText(input.organization, 'organization', 200) : null,
    addressLine1: supplier ? optionalText(input.address_line1, 'address_line1', 200) : null,
    addressLine2: supplier ? optionalText(input.address_line2, 'address_line2', 200) : null,
    city: supplier ? optionalText(input.city, 'city', 120) : null,
    region: supplier ? optionalText(input.region, 'region', 120) : null,
    postalCode: supplier ? optionalText(input.postal_code, 'postal_code', 32) : null,
    country: supplier ? optionalText(input.country, 'country', 80) : null,
    scopeId: null,
    autoRenew: input.auto_renew === true || input.auto_renew === 'true',
  }
}

async function assertRegistrationAvailable(database: D1Database, registration: ValidRegistration, environment: Env['ENV']): Promise<void> {
  const existing = await database.prepare('SELECT 1 FROM users WHERE username = ? LIMIT 1')
    .bind(registration.username).first()
  const pending = await database.prepare(`
    SELECT 1 FROM pending_registrations
    WHERE environment = ? AND status IN ('pending', 'checkout_created', 'paid')
      AND username = ? LIMIT 1
  `).bind(environment, registration.username).first()
  if (existing || pending) throw new AccountError(409, 'identity_unavailable', 'Username is already registered')
}

function farFuture(from: Date): string {
  return new Date(Date.UTC(from.getUTCFullYear() + 10, from.getUTCMonth(), from.getUTCDate())).toISOString()
}

async function createAccount(database: D1Database, registration: ValidRegistration, environment: Env['ENV']): Promise<{ username: string; role: string }> {
  const userId = newId()
  const now = new Date()
  const createdAt = now.toISOString()
  const passwordHash = await hashPassword(registration.password)
  const statements: D1PreparedStatement[] = [database.prepare(`
    INSERT INTO users (
      id, username, email, email_normalized, password_hash, role, totp_enabled,
      totp_required, session_version, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, 1, ?, ?)
  `).bind(userId, registration.username, registration.email, registration.email, passwordHash, registration.role, createdAt, createdAt)]
  statements.push(database.prepare(`
      INSERT INTO organizations (
        id, user_id, legal_name, address_line1, address_line2, city, region,
        postal_code, country, initial_mode, billing_email, organization_kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId(), userId, registration.organization ?? registration.username, registration.addressLine1 ?? '',
      registration.addressLine2, registration.city ?? '', registration.region,
      registration.postalCode ?? '', registration.country ?? '', registration.initialMode,
      registration.email, registration.role, createdAt, createdAt,
    ))
  statements.push(database.prepare(`
    INSERT INTO organization_memberships (
      organization_id, user_id, member_role, status, joined_at, created_at, updated_at
    ) SELECT id, user_id, 'owner', 'active', ?, ?, ? FROM organizations WHERE user_id = ?
  `).bind(createdAt, createdAt, createdAt, userId))
  if (registration.role === 'supplier') {
    const limits = await database.prepare(`
      SELECT write_rate_per_minute, records_per_write FROM billing_plans WHERE code = ? LIMIT 1
    `).bind(registration.planCode).first<{ write_rate_per_minute: number; records_per_write: number }>()
    if (!limits) throw new AccountError(500, 'plan_not_configured', 'Supplier plan is not configured')
    if (environment === 'dev') statements.push(database.prepare(`
      INSERT INTO entitlements (
        id, user_id, kind, scope_id, status, valid_from, valid_until, auto_renew,
        environment, plan_code, payment_status, write_rate_per_minute,
        records_per_write, created_at, updated_at
      ) VALUES (?, ?, 'writer_plan', NULL, 'active', ?, ?, 0, 'dev', ?,
                'development_bypass', ?, ?, ?, ?)
    `).bind(
      newId(), userId, createdAt, farFuture(now), registration.planCode,
      limits.write_rate_per_minute, limits.records_per_write, createdAt, createdAt,
    ))
  }
  await database.batch(statements)
  return { username: registration.username, role: registration.role }
}

function requiredConfiguration(environment: Env, field: keyof Env): string {
  const value = environment[field]
  if (typeof value !== 'string' || !value.trim()) throw new AccountError(503, 'configuration_required', `${String(field)} is not configured`)
  return value
}

function supplierPrice(environment: Env, plan: SupplierPlanCode): string {
  return requiredConfiguration(environment, `STRIPE_PRICE_PLAN_${plan}` as keyof Env)
}

async function createProductionCheckout(context: any, registration: ValidRegistration): Promise<{ checkout_url: string; pending_registration_id: string }> {
  if (registration.autoRenew && registration.role === 'verifier') {
    throw new AccountError(400, 'auto_renew_unavailable', 'Verifier auto-renew is not enabled for this Checkout configuration')
  }
  const database = requestDatabase(context)
  const pendingId = newId()
  const orderId = newId()
  const now = new Date()
  const createdAt = now.toISOString()
  const passwordHash = await hashPassword(registration.password)
  const amount = registration.role === 'supplier' ? PLAN_PRICES[registration.planCode!] : 2_900
  await database.batch([
    database.prepare(`
      INSERT INTO pending_registrations (
        id, environment, role, username, email, email_normalized, password_hash,
        legal_name, address_line1, address_line2, city, region, postal_code, country,
        initial_mode, plan_code, verifier_scope_id, auto_renew, status, expires_at,
        created_at, updated_at
      ) VALUES (?, 'prod', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                'pending', ?, ?, ?)
    `).bind(
      pendingId, registration.role, registration.username, registration.email,
      registration.email, passwordHash, registration.organization,
      registration.addressLine1, registration.addressLine2, registration.city,
      registration.region, registration.postalCode, registration.country,
      registration.initialMode, registration.planCode, registration.scopeId,
      registration.autoRenew ? 1 : 0,
      new Date(now.valueOf() + 24 * 60 * 60 * 1000).toISOString(), createdAt, createdAt,
    ),
    database.prepare(`
      INSERT INTO billing_orders (
        id, environment, order_type, pending_registration_id, scope_id, plan_code,
        amount_cents, currency, auto_renew, status, created_at, updated_at
      ) VALUES (?, 'prod', ?, ?, ?, ?, ?, 'usd', ?, 'pending', ?, ?)
    `).bind(
      orderId,
      registration.role === 'supplier' ? 'supplier_subscription' : 'verifier_read_pass',
      pendingId,
      registration.scopeId,
      registration.planCode,
      amount,
      registration.autoRenew ? 1 : 0,
      createdAt,
      createdAt,
    ),
  ])
  const origin = requiredConfiguration(context.env, 'APP_ORIGIN').replace(/\/$/u, '')
  const stripe = new StripeRestClient({ apiKey: requiredConfiguration(context.env, 'STRIPE_API_KEY') })
  try {
    const checkout = registration.role === 'supplier'
      ? await stripe.createSupplierSubscriptionCheckout({
        pendingRegistrationId: pendingId,
        planCode: registration.planCode!,
        priceId: supplierPrice(context.env, registration.planCode!),
        username: registration.username,
        customerEmail: registration.email,
        successUrl: `${origin}/checkout/success`,
        cancelUrl: `${origin}/checkout/cancelled`,
        idempotencyKey: `registration_${pendingId}`,
        environment: 'prod',
      })
      : await stripe.createVerifierReadPassCheckout({
        pendingRegistrationId: pendingId,
        scopeId: registration.scopeId!,
        priceId: requiredConfiguration(context.env, 'STRIPE_PRICE_READ_PASS'),
        username: registration.username,
        customerEmail: registration.email,
        successUrl: `${origin}/checkout/success`,
        cancelUrl: `${origin}/checkout/cancelled`,
        idempotencyKey: `registration_${pendingId}`,
        environment: 'prod',
      })
    if (!checkout.url) throw new AccountError(502, 'checkout_url_missing', 'Stripe did not return a Checkout URL')
    await database.batch([
      database.prepare(`
        UPDATE pending_registrations SET status = 'checkout_created',
          stripe_checkout_session_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'
      `).bind(checkout.id, new Date().toISOString(), pendingId),
      database.prepare(`
        UPDATE billing_orders SET status = 'checkout_created', stripe_checkout_session_id = ?,
          stripe_price_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'
      `).bind(
        checkout.id,
        registration.role === 'supplier' ? supplierPrice(context.env, registration.planCode!) : requiredConfiguration(context.env, 'STRIPE_PRICE_READ_PASS'),
        new Date().toISOString(),
        orderId,
      ),
    ])
    return { checkout_url: checkout.url, pending_registration_id: pendingId }
  } catch (error) {
    await database.batch([
      database.prepare("UPDATE pending_registrations SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'").bind(new Date().toISOString(), pendingId),
      database.prepare("UPDATE billing_orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'").bind(new Date().toISOString(), orderId),
    ])
    throw error
  }
}

function totpContext(environment: Env, userId: string) {
  return {
    userId,
    environment: environment.ENV,
    keyId: requiredConfiguration(environment, 'TOTP_KEY_ID'),
  } as const
}

function recoveryPepper(environment: Env): RecoveryCodePepper {
  return {
    keyId: requiredConfiguration(environment, 'TOTP_RECOVERY_KEY_ID'),
    secret: requiredConfiguration(environment, 'TOTP_RECOVERY_PEPPER'),
  }
}

async function verifySecondFactor(database: D1Database, environment: Env, userId: string, code: string): Promise<boolean> {
  const row = await database.prepare(`
    SELECT secret_ciphertext, last_used_counter FROM user_totp
    WHERE user_id = ? AND verified_at IS NOT NULL LIMIT 1
  `).bind(userId).first<{ secret_ciphertext: string; last_used_counter: number | null }>()
  if (!row) return false
  if (/^\d{6}$/.test(code.replace(/[\s-]/gu, ''))) {
    const envelope = JSON.parse(row.secret_ciphertext) as TotpSecretEnvelope
    const secret = await decryptTotpSecret(envelope, requiredConfiguration(environment, 'TOTP_ENCRYPTION_KEY'), totpContext(environment, userId))
    const result = await verifyTotpCode(secret, code, { lastUsedCounter: row.last_used_counter })
    if (!result.valid || result.counter == null) return false
    const updated = await database.prepare(`
      UPDATE user_totp SET last_used_counter = ?, last_used_at = ?, updated_at = ?
      WHERE user_id = ? AND (last_used_counter IS NULL OR last_used_counter < ?)
    `).bind(result.counter, new Date().toISOString(), new Date().toISOString(), userId, result.counter).run()
    return Boolean(updated.meta.changes)
  }
  const recoveryRows = await database.prepare(`
    SELECT id, code_hash FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL
  `).bind(userId).all<{ id: string; code_hash: string }>()
  for (const recovery of recoveryRows.results) {
    if (await verifyRecoveryCode(code, recovery.code_hash, userId, recoveryPepper(environment))) {
      const used = await database.prepare(`
        UPDATE totp_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL
      `).bind(new Date().toISOString(), recovery.id).run()
      return Boolean(used.meta.changes)
    }
  }
  return false
}

function publicActor(actor: SessionActor) {
  return {
    id: actor.user.id,
    username: actor.user.username,
    role: actor.user.role,
    email: actor.email,
    supplier_mode: actor.supplierMode,
    totp_enabled: actor.user.totpEnabled,
  }
}

export function createAccountRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>()

  routes.get('/username/:username', async (context) => {
    let username: string
    try { username = validateUsername(context.req.param('username')) }
    catch { return context.json({ available: false, reason: 'invalid' }) }
    const database = requestDatabase(context)
    const current = await database.prepare('SELECT 1 FROM users WHERE username = ? LIMIT 1').bind(username).first()
    const pending = await database.prepare(`
      SELECT 1 FROM pending_registrations WHERE environment = ? AND username = ?
        AND status IN ('pending', 'checkout_created', 'paid') LIMIT 1
    `).bind(context.env.ENV, username).first()
    return context.json({ available: !current && !pending, reason: current || pending ? 'unavailable' : undefined })
  })

  routes.post('/register', async (context) => {
    assertPublicMutationOrigin(context)
    const registration = validateRegistration(await context.req.json<RegistrationInput>())
    const database = requestDatabase(context)
    await assertRegistrationAvailable(database, registration, context.env.ENV)
    return context.json({ created: true, ...await createAccount(database, registration, context.env.ENV) }, 201)
  })

  routes.post('/login', async (context) => {
    assertPublicMutationOrigin(context)
    const body = requirePlainRecord(await context.req.json(), 'login')
    const username = validateUsername(body.username)
    const password = typeof body.password === 'string' ? body.password : ''
    const database = requestDatabase(context)
    const user = await database.prepare(`
      SELECT id, username, password_hash, role, is_active, disabled_at,
             session_version, totp_enabled
      FROM users WHERE username = ? LIMIT 1
    `).bind(username).first<{
      id: string
      username: string
      password_hash: string
      role: 'supplier' | 'verifier'
      is_active: number
      disabled_at: string | null
      session_version: number
      totp_enabled: number
    }>()
    const checked = await verifyLoginPassword(password, user?.password_hash)
    if (!user || !checked.valid || !user.is_active || user.disabled_at) {
      throw new AccountError(401, 'invalid_credentials', 'Invalid credentials')
    }
    if (user.totp_enabled) {
      if (typeof body.totp_code !== 'string' || !body.totp_code.trim()) {
        throw new AccountError(401, 'totp_required', 'Authenticator or recovery code required')
      }
      if (!(await verifySecondFactor(database, context.env, user.id, body.totp_code))) {
        throw new AccountError(401, 'invalid_second_factor', 'Invalid credentials')
      }
    }
    const updates: D1PreparedStatement[] = [database.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').bind(new Date().toISOString(), new Date().toISOString(), user.id)]
    if (checked.replacementHash) updates.push(database.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(checked.replacementHash, new Date().toISOString(), user.id))
    await database.batch(updates)
    const browserSession = await createBrowserSession(context, {
      id: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: user.session_version,
    })
    return context.json({ logged_in: true, username: user.username, role: user.role, csrf_token: browserSession.csrfToken })
  })

  routes.get('/session', async (context) => {
    const actor = await currentSession(context)
    return context.json({ authenticated: true, user: publicActor(actor), csrf_token: await refreshCsrf(context, actor) })
  })

  routes.post('/logout', async (context) => {
    const actor = await optionalSession(context)
    if (actor) {
      await assertSessionMutation(context, actor)
      await revokeSession(context, actor)
    } else {
      clearAuthenticationCookies(context)
    }
    return context.json({ logged_out: true })
  })

  routes.get('/dashboard', async (context) => {
    const actor = await currentSession(context)
    const database = requestDatabase(context)
    const owner = actor.user.id
    const [cases, sources, events, failedAnchors, receipts] = await Promise.all([
      database.prepare('SELECT COUNT(*) AS count FROM cases WHERE owner_id = ?').bind(owner).first<{ count: number }>(),
      database.prepare('SELECT COUNT(*) AS count FROM sources WHERE owner_id = ?').bind(owner).first<{ count: number }>(),
      database.prepare('SELECT COUNT(*) AS count FROM events WHERE owner_id = ?').bind(owner).first<{ count: number }>(),
      database.prepare("SELECT COUNT(*) AS count FROM events WHERE owner_id = ? AND anchor_status = 'anchor_failed'").bind(owner).first<{ count: number }>(),
      database.prepare(`
        SELECT e.event_type, e.action, e.received_at, e.anchor_status, e.id AS event_id
        FROM events e WHERE e.owner_id = ? ORDER BY e.received_at DESC LIMIT 8
      `).bind(owner).all<Record<string, unknown>>(),
    ])
    return context.json({
      environment: context.env.ENV,
      user: publicActor(actor),
      entitlements: actor.entitlements.map((item) => ({
        id: item.id,
        kind: item.kind,
        scope_id: item.scopeId,
        plan_code: item.planCode,
        status: item.status,
        valid_from: item.validFrom,
        valid_until: item.validUntil,
        auto_renew: item.autoRenew,
      })),
      counts: {
        cases: Number(cases?.count ?? 0),
        sources: Number(sources?.count ?? 0),
        events: Number(events?.count ?? 0),
        anchor_failures: Number(failedAnchors?.count ?? 0),
      },
      recent_receipts: receipts.results,
    })
  })

  routes.post('/security/totp/start', async (context) => {
    const actor = await currentSession(context)
    await assertSessionMutation(context, actor)
    if (actor.user.totpEnabled) throw new AccountError(409, 'totp_already_enabled', 'TOTP is already enabled')
    const enrollment = createTotpEnrollment('Outdock', actor.user.username)
    const envelope = await encryptTotpSecret(
      enrollment.secret,
      requiredConfiguration(context.env, 'TOTP_ENCRYPTION_KEY'),
      totpContext(context.env, actor.user.id),
    )
    const now = new Date().toISOString()
    await requestDatabase(context).prepare(`
      INSERT INTO user_totp (
        user_id, secret_ciphertext, secret_iv, secret_key_id, algorithm, digits,
        period, last_used_counter, last_used_at, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext = excluded.secret_ciphertext,
        secret_iv = excluded.secret_iv, secret_key_id = excluded.secret_key_id,
        algorithm = excluded.algorithm, digits = excluded.digits, period = excluded.period,
        last_used_counter = NULL, last_used_at = NULL, verified_at = NULL,
        updated_at = excluded.updated_at
      WHERE user_totp.verified_at IS NULL
    `).bind(
      actor.user.id, JSON.stringify(envelope), envelope.iv, envelope.key_id,
      enrollment.parameters.algorithm, enrollment.parameters.digits,
      enrollment.parameters.period, now, now,
    ).run()
    const qrSvg = await qrToString(enrollment.otpauthUri, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 256,
    })
    if (qrSvg.length > 100_000) throw new AccountError(500, 'totp_qr_failed', 'TOTP QR code could not be generated')
    return context.json({
      otpauth_uri: enrollment.otpauthUri,
      manual_secret: enrollment.secret,
      qr_data_url: `data:image/svg+xml;base64,${btoa(qrSvg)}`,
    })
  })

  routes.post('/security/totp/confirm', async (context) => {
    const actor = await currentSession(context)
    await assertSessionMutation(context, actor)
    const body = requirePlainRecord(await context.req.json(), 'TOTP confirmation')
    const code = requireString(body.code, 'code', { max: 16 })
    const database = requestDatabase(context)
    const stored = await database.prepare(`
      SELECT secret_ciphertext FROM user_totp WHERE user_id = ? AND verified_at IS NULL LIMIT 1
    `).bind(actor.user.id).first<{ secret_ciphertext: string }>()
    if (!stored) throw new AccountError(404, 'totp_enrollment_not_found', 'Start TOTP enrollment first')
    const result = await confirmTotpEnrollment(
      JSON.parse(stored.secret_ciphertext) as TotpSecretEnvelope,
      requiredConfiguration(context.env, 'TOTP_ENCRYPTION_KEY'),
      totpContext(context.env, actor.user.id),
      code,
    )
    if (!result.valid || result.counter == null) throw new AccountError(400, 'invalid_totp_code', 'Authenticator code is invalid')
    const recoveryCodes = generateRecoveryCodes()
    const hashes = await hashRecoveryCodes(recoveryCodes, actor.user.id, recoveryPepper(context.env))
    const now = new Date().toISOString()
    const statements: D1PreparedStatement[] = [
      database.prepare(`
        UPDATE user_totp SET verified_at = ?, last_used_counter = ?, last_used_at = ?, updated_at = ?
        WHERE user_id = ? AND verified_at IS NULL
      `).bind(now, result.counter, now, now, actor.user.id),
      database.prepare('UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?').bind(now, actor.user.id),
      database.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').bind(actor.user.id),
    ]
    hashes.forEach((hash) => statements.push(database.prepare(`
      INSERT INTO totp_recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)
    `).bind(newId(), actor.user.id, hash, now)))
    await database.batch(statements)
    return context.json({ enabled: true, recovery_codes: recoveryCodes })
  })

  routes.post('/security/sessions/revoke', async (context) => {
    const actor = await currentSession(context)
    await assertSessionMutation(context, actor)
    await requestDatabase(context).prepare(`
      UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL
    `).bind(new Date().toISOString(), actor.user.id, actor.sessionId).run()
    return context.json({ revoked: true })
  })

  return routes
}
