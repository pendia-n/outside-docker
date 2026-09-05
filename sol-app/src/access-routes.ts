import { Hono } from 'hono'
import { quoteOneTimeRange, quoteSubscriptionWindow } from './access'
import { DomainError } from './chain-do'
import type { StripeRestClient } from './billing'
import { randomBytes, sha256Hex } from './validation'

export interface AccessActor {
  userId: string
  username: string
  email: string | null
  role: 'supplier' | 'verifier'
  sessionId: string
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

function required(value: unknown, field: string, maximum = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new DomainError(400, 'invalid_request', `${field} is required`)
  return value.trim()
}

function reference(value: unknown, field: string): string {
  const output = required(value, field)
  if (!REF.test(output)) throw new DomainError(400, 'invalid_reference', `${field} contains unsupported characters`)
  return output
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function tokenHash(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`OUTDOCK|INVITATION|1|${token}`))
}

export function createAccessRoutes(dependencies: {
  database(context: any): D1Database
  authenticate(context: any): Promise<AccessActor | null>
  authorizeMutation(actor: AccessActor, context: any): Promise<void>
  stripe(context: any): StripeRestClient
  origin(context: any): string
  environment(context: any): 'dev' | 'prod'
  priceIds(context: any): { full: string; discounted: string; subscription: string }
}): Hono {
  const routes = new Hono()
  const actor = async (context: any, role?: AccessActor['role'], mutation = false) => {
    const authenticated = await dependencies.authenticate(context)
    if (!authenticated) throw new DomainError(401, 'authentication_required', 'Login required')
    if (role && authenticated.role !== role) throw new DomainError(403, `${role}_required`, `${role === 'supplier' ? 'Supplier' : 'Verifier'} access required`)
    if (mutation) await dependencies.authorizeMutation(authenticated, context)
    return authenticated
  }

  routes.post('/supplier/invitations', async (context) => {
    const authenticated = await actor(context, 'supplier', true)
    const body = await context.req.json<Record<string, unknown>>()
    const eventTypeRef = reference(body.event_type_ref, 'event_type_ref')
    const database = dependencies.database(context)
    const eventType = await database.prepare(`
      SELECT t.id, t.organization_id FROM supplier_event_types t
      WHERE t.owner_id = ? AND t.event_type_ref = ? AND t.status = 'active' LIMIT 1
    `).bind(authenticated.userId, eventTypeRef).first<{ id: string; organization_id: string | null }>()
    if (!eventType) throw new DomainError(404, 'event_type_not_found', 'Active event type not found')
    const token = `odi_${b64url(randomBytes(32))}`
    const id = crypto.randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.valueOf() + 14 * 86_400_000).toISOString()
    await database.batch([
      database.prepare(`
        INSERT INTO verifier_invitations (
          id, supplier_user_id, supplier_organization_id, event_type_id, token_hash,
          token_prefix, status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).bind(id, authenticated.userId, eventType.organization_id, eventType.id, await tokenHash(token), token.slice(0, 12), expiresAt, now.toISOString(), now.toISOString()),
      database.prepare(`INSERT INTO access_offers (id, invitation_id, supplier_user_id, event_type_id, access_model, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'one_time_range', 'active', ?, ?)`)
        .bind(crypto.randomUUID(), id, authenticated.userId, eventType.id, now.toISOString(), now.toISOString()),
      database.prepare(`INSERT INTO access_offers (id, invitation_id, supplier_user_id, event_type_id, access_model, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'subscription_28d', 'active', ?, ?)`)
        .bind(crypto.randomUUID(), id, authenticated.userId, eventType.id, now.toISOString(), now.toISOString()),
    ])
    return context.json({ id, event_type_ref: eventTypeRef, invitation_token: token, expires_at: expiresAt }, 201)
  })

  routes.post('/verifier/invitations/accept', async (context) => {
    const authenticated = await actor(context, 'verifier', true)
    const token = required((await context.req.json<Record<string, unknown>>()).token, 'token', 200)
    const now = new Date().toISOString()
    const database = dependencies.database(context)
    const organization = await database.prepare('SELECT id FROM organizations WHERE user_id = ? AND organization_kind = \'verifier\' LIMIT 1')
      .bind(authenticated.userId).first<{ id: string }>()
    const result = await database.prepare(`
      UPDATE verifier_invitations SET verifier_user_id = ?, verifier_organization_id = ?,
        status = 'accepted', accepted_at = ?, updated_at = ?
      WHERE token_hash = ? AND status = 'pending' AND expires_at > ? AND verifier_user_id IS NULL
    `).bind(authenticated.userId, organization?.id ?? null, now, now, await tokenHash(token), now).run()
    if ((result.meta?.changes ?? 0) !== 1) throw new DomainError(404, 'invitation_unavailable', 'Invitation is invalid, expired, or already accepted')
    return context.json({ accepted: true })
  })

  routes.get('/verifier/offers', async (context) => {
    const authenticated = await actor(context, 'verifier')
    const rows = await dependencies.database(context).prepare(`
      SELECT o.id, o.access_model, t.event_type_ref, t.name AS event_type_name,
             u.username AS supplier_username, i.accepted_at, i.expires_at
      FROM access_offers o
      JOIN verifier_invitations i ON i.id = o.invitation_id
      JOIN supplier_event_types t ON t.id = o.event_type_id
      JOIN users u ON u.id = o.supplier_user_id
      WHERE i.verifier_user_id = ? AND i.status = 'accepted' AND o.status = 'active'
      ORDER BY i.accepted_at DESC, t.name, o.access_model
    `).bind(authenticated.userId).all<Record<string, unknown>>()
    return context.json({ offers: rows.results })
  })

  routes.post('/verifier/offers/:offerId/quote', async (context) => {
    await actor(context, 'verifier')
    const body = await context.req.json<Record<string, unknown>>()
    const model = required(body.access_model, 'access_model', 32)
    const quote = model === 'subscription_28d'
      ? quoteSubscriptionWindow(new Date())
      : quoteOneTimeRange(required(body.range_start, 'range_start', 64), required(body.range_end, 'range_end', 64))
    return context.json(quote)
  })

  routes.post('/verifier/offers/:offerId/checkout', async (context) => {
    const authenticated = await actor(context, 'verifier', true)
    const database = dependencies.database(context)
    const offer = await database.prepare(`
      SELECT o.id, o.access_model, o.event_type_id
      FROM access_offers o JOIN verifier_invitations i ON i.id = o.invitation_id
      WHERE o.id = ? AND o.status = 'active' AND i.status = 'accepted' AND i.verifier_user_id = ? LIMIT 1
    `).bind(context.req.param('offerId'), authenticated.userId).first<{ id: string; access_model: 'one_time_range' | 'subscription_28d'; event_type_id: string }>()
    if (!offer) throw new DomainError(404, 'offer_not_found', 'Active access offer not found')
    const body = await context.req.json<Record<string, unknown>>()
    const quote = offer.access_model === 'subscription_28d'
      ? quoteSubscriptionWindow(new Date())
      : quoteOneTimeRange(required(body.range_start, 'range_start', 64), required(body.range_end, 'range_end', 64))
    const orderId = crypto.randomUUID()
    const now = new Date().toISOString()
    await database.prepare(`
      INSERT INTO access_orders (
        id, environment, verifier_user_id, offer_id, event_type_id, access_model,
        range_start, range_end, seven_day_units, amount_cents, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).bind(orderId, dependencies.environment(context), authenticated.userId, offer.id, offer.event_type_id,
      offer.access_model, quote.rangeStart, quote.rangeEnd, quote.sevenDayUnits, quote.amountCents, now, now).run()
    try {
      const prices = dependencies.priceIds(context)
      const checkout = await dependencies.stripe(context).createAccessCheckout({
        orderId,
        accessModel: offer.access_model,
        fullPriceUnits: quote.fullPriceUnits ?? 0,
        discountedUnits: quote.discountedUnits ?? 0,
        fullPriceId: prices.full,
        discountedPriceId: prices.discounted,
        subscriptionPriceId: prices.subscription,
        username: authenticated.username,
        customerEmail: authenticated.email,
        successUrl: `${dependencies.origin(context)}/checkout/success?order=${encodeURIComponent(orderId)}`,
        cancelUrl: `${dependencies.origin(context)}/app#verifier-access`,
        idempotencyKey: `access_checkout_${orderId}`,
        environment: dependencies.environment(context),
      })
      await database.prepare(`UPDATE access_orders SET status = 'checkout_created', stripe_checkout_session_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(checkout.id, new Date().toISOString(), orderId).run()
      if (!checkout.url) throw new DomainError(502, 'checkout_url_missing', 'Stripe did not return a Checkout URL')
      return context.json({ order_id: orderId, checkout_url: checkout.url, quote })
    } catch (error) {
      await database.prepare(`UPDATE access_orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(new Date().toISOString(), orderId).run()
      throw error
    }
  })

  routes.get('/verifier/grants', async (context) => {
    const authenticated = await actor(context, 'verifier')
    const rows = await dependencies.database(context).prepare(`
      SELECT g.id, g.access_model, g.data_from, g.data_until, g.access_from, g.access_until,
             g.include_future_until, g.status, t.event_type_ref, t.name AS event_type_name,
             u.username AS supplier_username
      FROM access_grants g JOIN supplier_event_types t ON t.id = g.event_type_id
      JOIN users u ON u.id = g.supplier_user_id
      WHERE g.verifier_user_id = ? ORDER BY g.created_at DESC
    `).bind(authenticated.userId).all<Record<string, unknown>>()
    return context.json({ grants: rows.results })
  })

  routes.get('/verifier/grants/:grantId/events', async (context) => {
    const authenticated = await actor(context, 'verifier')
    const database = dependencies.database(context)
    const now = new Date().toISOString()
    const grant = await database.prepare(`
      SELECT * FROM access_grants WHERE id = ? AND verifier_user_id = ? AND status = 'active'
        AND access_from <= ? AND access_until > ? LIMIT 1
    `).bind(context.req.param('grantId'), authenticated.userId, now, now).first<Record<string, any>>()
    if (!grant) throw new DomainError(403, 'access_grant_inactive', 'Access grant is missing or expired')
    const effectiveEnd = grant.include_future_until && grant.include_future_until < grant.data_until ? grant.include_future_until : grant.data_until
    const events = await database.prepare(`
      SELECT e.id, e.track, e.event_type AS action, e.occurred_at, e.received_at, e.position,
             e.commitment, e.manifest_hash, e.previous_proof, e.proof, e.anchor_status,
             e.anchor_batch_id, r.receipt_json, r.signature, r.signing_key_id, r.signature_algorithm
      FROM events e JOIN receipts r ON r.event_id = e.id
      WHERE e.owner_id = ? AND e.event_type_id = ?
        AND COALESCE(e.occurred_at, e.received_at) >= ? AND COALESCE(e.occurred_at, e.received_at) < ?
      ORDER BY COALESCE(e.occurred_at, e.received_at), e.position, e.id
    `).bind(grant.supplier_user_id, grant.event_type_id, grant.data_from, effectiveEnd).all<Record<string, unknown>>()
    const viewSessionId = crypto.randomUUID()
    const watermarkRef = `OUTDOCK-${authenticated.username}-${viewSessionId.slice(0, 8)}`
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
    await database.batch([
      database.prepare(`INSERT INTO evidence_view_sessions (id, access_grant_id, verifier_user_id, session_id, watermark_ref, started_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(viewSessionId, grant.id, authenticated.userId, authenticated.sessionId, watermarkRef, now, expiresAt, now),
      database.prepare(`INSERT INTO evidence_access_logs (id, access_grant_id, view_session_id, verifier_user_id, action, outcome, occurred_at) VALUES (?, ?, ?, ?, 'list', 'allowed', ?)`)
        .bind(crypto.randomUUID(), grant.id, viewSessionId, authenticated.userId, now),
    ])
    context.header('Cache-Control', 'no-store')
    context.header('Content-Disposition', 'inline')
    return context.json({ grant, events: events.results, download_allowed: false, watermark: watermarkRef, view_expires_at: expiresAt })
  })

  return routes
}
