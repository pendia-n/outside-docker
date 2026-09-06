import { Contract, JsonRpcProvider, Wallet } from 'ethers'
import { Hono, type Context } from 'hono'
import { AccountError, createAccountRoutes } from './account-routes'
import { PolygonAnchorService, createEthersAnchorClient, type EthersAnchorContractLike } from './anchor'
import { AuthenticationError, AuthorizationError, RequestSecurityError } from './auth'
import {
  StripeApiError,
  StripeRestClient,
  StripeWebhookError,
  createD1BillingEventHandler,
  createD1StripeWebhookStore,
  processStripeWebhook,
  type StripeEvent,
} from './billing'
import { quoteSubscriptionWindow } from './access'
import { createAccessRoutes } from './access-routes'
import { DomainError, createChainDurableObject, durableObjectChainAppender } from './chain-do'
import { createEventCatalogRoutes } from './event-catalog'
import { databaseFor } from './db'
import { ApplicationPage, CheckoutStatusPage, LandingPage, VerifyPage } from './pages'
import { createProofPdfResponse } from './pdf'
import {
  activeEntitlement,
  assertSessionMutation,
  currentSession,
  optionalSession,
  requestDatabase,
  requireSupplierMode,
  type AppContext,
  type SessionActor,
} from './platform'
import { consumeHumanWrite, machinePlanProvider } from './plans'
import { ensureReceiptPublicKey, receiptSigner } from './receipt-keys'
import { ReceiptError } from './receipts'
import { renderer } from './renderer'
import { createTrackHRoutes } from './track-h'
import {
  authenticateMachineApiKey,
  createTrackMManagementRoutes,
  createTrackMRoutes,
} from './track-m'
import type { Env } from './types'
import { ValidationError, requirePlainRecord, requireString } from './validation'
import {
  VerifierService,
  createVerifierRoutes,
  verifyPortableProof,
  type PortableProofV1,
  type VerificationActor,
} from './verifier'

type AppEnvironment = { Bindings: Env; Variables: { requestId: string } }
type WorkerContext = Context<AppEnvironment>

const app = new Hono<AppEnvironment>()
const MAX_REQUEST_BYTES = 15_000_000

function requestId(context: WorkerContext): string {
  return context.get('requestId') || crypto.randomUUID()
}

function platformContext(context: WorkerContext): AppContext {
  return context as unknown as AppContext
}

function statusOf(error: unknown): number {
  if (
    error instanceof AccountError
    || error instanceof AuthenticationError
    || error instanceof AuthorizationError
    || error instanceof DomainError
    || error instanceof RequestSecurityError
    || error instanceof StripeApiError
    || error instanceof StripeWebhookError
  ) return error.status
  if (error instanceof ValidationError || error instanceof ReceiptError) return 400
  return 500
}

function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return 'internal_error'
}

function publicMessage(error: unknown, environment: Env['ENV']): string {
  if (statusOf(error) < 500 || environment === 'dev') return error instanceof Error ? error.message : 'Request failed'
  return 'Internal Server Error'
}

app.use('*', async (context, next) => {
  const id = context.req.header('CF-Ray') || crypto.randomUUID()
  context.set('requestId', id)
  const declaredLength = Number(context.req.header('Content-Length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return context.json({ error: 'Request body is too large', code: 'request_too_large', request_id: id }, 413)
  }
  await next()
  context.header('X-Request-Id', id)
  context.header('X-Content-Type-Options', 'nosniff')
  context.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)')
  context.header('Cross-Origin-Opener-Policy', 'same-origin')
  context.header('Cross-Origin-Resource-Policy', 'same-origin')
  context.header(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  )
  if (new URL(context.req.url).protocol === 'https:') {
    context.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
})

app.onError((error, context) => {
  const status = statusOf(error)
  if (status >= 500) console.error(error)
  return context.json({
    error: publicMessage(error, context.env.ENV),
    code: codeOf(error),
    request_id: requestId(context),
  }, status as any)
})

app.use(renderer)

function required(environment: Env, field: keyof Env): string {
  const value = environment[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new AccountError(503, 'configuration_required', `${String(field)} is not configured`)
  }
  return value.trim()
}

function applicationOrigin(context: WorkerContext): string {
  const parsed = new URL(context.env.APP_ORIGIN || new URL(context.req.url).origin)
  if (context.env.ENV === 'prod' && parsed.protocol !== 'https:') {
    throw new AccountError(503, 'configuration_required', 'APP_ORIGIN must use HTTPS in production')
  }
  return parsed.origin
}

function sessionVerificationActor(actor: SessionActor): VerificationActor {
  return { userId: actor.user.id, role: actor.user.role }
}

async function sessionFor(context: WorkerContext): Promise<SessionActor | null> {
  return optionalSession(platformContext(context))
}

async function requireSupplier(context: WorkerContext): Promise<SessionActor> {
  const actor = await currentSession(platformContext(context))
  if (actor.user.role !== 'supplier') throw new AuthorizationError('Supplier access required', 403, 'supplier_required')
  return actor
}

function stripeClient(environment: Env): StripeRestClient {
  return new StripeRestClient({ apiKey: required(environment, 'STRIPE_API_KEY') })
}

export const ChainCoordinator = createChainDurableObject<Env>({
  database: databaseFor,
  environment: (environment) => environment.ENV,
  signer: async (environment) => {
    await ensureReceiptPublicKey(databaseFor(environment), environment)
    return receiptSigner(environment)
  },
})

app.get('/', (context) => context.render(<LandingPage />))
app.get('/app', async (context) => {
  const actor = await sessionFor(context)
  if (!actor) return context.redirect('/#login-card')
  return context.render(<ApplicationPage role={actor.user.role} supplierMode={actor.supplierMode} />)
})
app.get('/verify', (context) => context.render(<VerifyPage />))
app.get('/verify/:token', (context) => context.render(<VerifyPage shareToken={context.req.param('token')} />))
app.get('/checkout/success', (context) => context.render(<CheckoutStatusPage state="success" />))
app.get('/checkout/cancelled', (context) => context.render(<CheckoutStatusPage state="cancelled" />))

app.get('/health', (context) => context.json({
  ok: true,
  app: 'outside-docker',
  environment: context.env.ENV,
  database: context.env.ENV === 'prod' ? 'DB_PROD' : 'DB_DEV',
  base_chain_id: context.env.ENV === 'prod' ? context.env.BASE_CHAIN_ID_PROD : context.env.BASE_CHAIN_ID_DEV,
}))

app.route('/api', createAccountRoutes())

app.route('/api', createEventCatalogRoutes({
  database: (context) => requestDatabase(context),
  authenticate: async (context) => {
    const actor = await sessionFor(context)
    return actor ? { userId: actor.user.id, role: actor.user.role } : null
  },
  authorizeWrite: async (_actor, context) => {
    const actor = await currentSession(context)
    await assertSessionMutation(context, actor)
    if (!activeEntitlement(actor, 'writer_plan')) {
      throw new AuthorizationError('An active Supplier plan is required', 402, 'active_plan_required')
    }
  },
}))

app.route('/api', createAccessRoutes({
  database: (context) => requestDatabase(context),
  authenticate: async (context) => {
    const actor = await sessionFor(context)
    return actor ? {
      userId: actor.user.id,
      username: actor.user.username,
      email: null,
      role: actor.user.role,
      sessionId: actor.sessionId,
    } : null
  },
  authorizeMutation: async (_actor, context) => {
    const actor = await currentSession(context)
    await assertSessionMutation(context, actor)
  },
  stripe: (context) => stripeClient(context.env),
  origin: applicationOrigin,
  environment: (context) => context.env.ENV,
  priceIds: (context) => ({
    full: required(context.env, 'STRIPE_PRICE_VERIFIER_7D'),
    discounted: required(context.env, 'STRIPE_PRICE_VERIFIER_7D_DISCOUNTED'),
    subscription: required(context.env, 'STRIPE_PRICE_VERIFIER_SUBSCRIPTION_28D'),
  }),
}))

const chainAppender = (context: WorkerContext) => durableObjectChainAppender(context.env.CHAIN_COORDINATOR)

app.route('/api/h', createTrackHRoutes({
  database: (context) => requestDatabase(context),
  chainAppender,
  authenticate: async (context) => {
    const actor = await sessionFor(context)
    return actor ? { userId: actor.user.id, role: actor.user.role, sessionId: actor.sessionId } : null
  },
  authorizeWrite: async (_publicActor, context) => {
    const actor = await currentSession(context)
    await assertSessionMutation(context, actor)
    requireSupplierMode(actor, 'H')
    await consumeHumanWrite(requestDatabase(context), actor.user.id)
  },
}))

app.route('/api/v1', createTrackMRoutes({
  database: (context) => requestDatabase(context),
  chainAppender,
  plans: (context) => machinePlanProvider(requestDatabase(context)),
  environment: (context) => context.env.ENV,
  authenticateApiKey: (context) => authenticateMachineApiKey(
    requestDatabase(context),
    context.req.header('Authorization'),
    context.env.ENV,
  ),
  authenticateOwner: async (context) => {
    const actor = await sessionFor(context)
    return actor ? { userId: actor.user.id, role: actor.user.role } : null
  },
  authorizeSourceWrite: async (_publicActor, context) => {
    const actor = await currentSession(context)
    await assertSessionMutation(context, actor)
    requireSupplierMode(actor, 'M')
  },
}))

app.route('/api', createTrackMManagementRoutes({
  database: (context) => requestDatabase(context),
  environment: (context) => context.env.ENV,
  authenticateOwner: async (context) => {
    const actor = await sessionFor(context)
    return actor ? { userId: actor.user.id, role: actor.user.role } : null
  },
  authorizeKeyWrite: async (_publicActor, context) => {
    const actor = await currentSession(context)
    await assertSessionMutation(context, actor)
    requireSupplierMode(actor, 'M')
  },
}))

app.route('/api/evidence', createVerifierRoutes({
  database: (context) => requestDatabase(context),
  authenticate: async (context) => {
    const actor = await sessionFor(context)
    return actor ? sessionVerificationActor(actor) : null
  },
  authorizeSupplierPublish: async (_publicActor, context) => {
    const actor = await currentSession(context)
    await assertSessionMutation(context, actor)
    if (actor.user.role !== 'supplier' || !activeEntitlement(actor, 'writer_plan')) {
      throw new AuthorizationError('An active supplier plan is required', 402, 'entitlement_required')
    }
  },
}))

app.get('/api/receipt-public-key', async (context) => {
  const database = requestDatabase(context)
  const requested = context.req.query('key_id')?.trim()
  if (!requested) {
    const document = await ensureReceiptPublicKey(database, context.env)
    return context.json({ ...document, jwk: document.public_key_jwk, public_key_id: document.key_id })
  }
  const row = await database.prepare(`
    SELECT id, environment, algorithm, public_key_jwk
    FROM receipt_signing_keys
    WHERE id = ? AND environment = ? AND status IN ('active', 'retired') LIMIT 1
  `).bind(requested, context.env.ENV).first<{
    id: string
    environment: Env['ENV']
    algorithm: string
    public_key_jwk: string
  }>()
  if (!row) throw new DomainError(404, 'receipt_key_not_found', 'Receipt verification key not found')
  const jwk = JSON.parse(row.public_key_jwk) as JsonWebKey
  return context.json({
    version: 'OD-RECEIPT-KEY-1',
    environment: row.environment,
    key_id: row.id,
    public_key_id: row.id,
    algorithm: row.algorithm,
    public_key_jwk: jwk,
    jwk,
  })
})

async function trustedReceiptKeys(database: D1Database, environment: Env['ENV']): Promise<Record<string, JsonWebKey>> {
  const rows = await database.prepare(`
    SELECT id, public_key_jwk FROM receipt_signing_keys
    WHERE environment = ? AND status IN ('active', 'retired')
  `).bind(environment).all<{ id: string; public_key_jwk: string }>()
  return Object.fromEntries(rows.results.map((row) => [row.id, JSON.parse(row.public_key_jwk) as JsonWebKey]))
}

function polygonVerifier(environment: Env) {
  return async (anchor: NonNullable<PortableProofV1['anchor']>): Promise<boolean> => {
    const configuredAddress = environment.ENV === 'prod'
      ? required(environment, 'BASE_CONTRACT_ADDRESS_PROD')
      : required(environment, 'BASE_CONTRACT_ADDRESS_DEV')
    if (
      anchor.chain_id !== (environment.ENV === 'prod' ? environment.BASE_CHAIN_ID_PROD : environment.BASE_CHAIN_ID_DEV)
      || anchor.contract_address.toLowerCase() !== configuredAddress.toLowerCase()
      || !environment.BASE_RPC_URL
    ) return false
    const provider = new JsonRpcProvider(
      environment.BASE_RPC_URL,
      Number(environment.ENV === 'prod' ? environment.BASE_CHAIN_ID_PROD : environment.BASE_CHAIN_ID_DEV),
      { staticNetwork: true },
    )
    const contract = new Contract(configuredAddress, [
      'function anchorIdByBatch(bytes32 batchId) view returns (uint256)',
      'function verify(uint256 anchorId, bytes32 merkleRoot, bytes32 manifestHash) view returns (bool)',
      'event AnchorBatch(uint256 indexed anchorId, bytes32 indexed batchId, bytes32 indexed merkleRoot, bytes32 manifestHash, uint32 leafCount, uint32 eventCount, uint64 anchoredAt)',
    ], provider)
    const batchId = `0x${anchor.batch_ref.replace(/^0x/u, '')}`
    const merkleRoot = `0x${anchor.merkle_root.replace(/^0x/u, '')}`
    const manifestHash = `0x${anchor.manifest_hash.replace(/^0x/u, '')}`
    const anchorId = await contract.anchorIdByBatch(batchId) as bigint
    if (anchorId <= 0n) return false
    if (!await contract.verify(anchorId, merkleRoot, manifestHash)) return false

    const receipt = await provider.getTransactionReceipt(anchor.transaction_hash)
    if (
      !receipt
      || receipt.status !== 1
      || receipt.to?.toLowerCase() !== configuredAddress.toLowerCase()
      || anchor.block_number == null
      || receipt.blockNumber !== anchor.block_number
      || !anchor.block_hash
      || receipt.blockHash.toLowerCase() !== anchor.block_hash.toLowerCase()
    ) return false
    return receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== configuredAddress.toLowerCase()) return false
      try {
        const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data })
        return parsed?.name === 'AnchorBatch'
          && String(parsed.args.batchId).toLowerCase() === batchId.toLowerCase()
          && String(parsed.args.merkleRoot).toLowerCase() === merkleRoot.toLowerCase()
          && String(parsed.args.manifestHash).toLowerCase() === manifestHash.toLowerCase()
          && BigInt(parsed.args.anchorId) === anchorId
      } catch {
        return false
      }
    })
  }
}

app.post('/api/verify-proof', async (context) => {
  const body = requirePlainRecord(await context.req.json(), 'proof verification')
  const proof = body.proof as PortableProofV1
  if (!proof || typeof proof !== 'object') throw new ValidationError('proof is required', 'invalid_proof', 'proof')
  const result = await verifyPortableProof(proof, {
    trustedPublicKeys: await trustedReceiptKeys(requestDatabase(context), context.env.ENV),
    expectedEnvironment: context.env.ENV,
    verifyPolygonAnchor: proof.anchor ? polygonVerifier(context.env) : undefined,
    requirePolygon: Boolean(proof.anchor),
  })
  return context.json(result, result.valid ? 200 : 422)
})

app.get('/api/verifier/scopes', async (context) => {
  const actor = await currentSession(platformContext(context))
  if (actor.user.role !== 'verifier') throw new AuthorizationError('Verifier access required', 403, 'verifier_required')
  const now = new Date().toISOString()
  const scopes = await requestDatabase(context).prepare(`
    SELECT sc.id, sc.scope_type, sc.scope_ref, sc.title, sc.summary, sc.published_at,
           e.valid_from, e.valid_until, e.status AS entitlement_status
    FROM entitlements e JOIN evidence_scopes sc ON sc.id = e.scope_id
    WHERE e.user_id = ? AND e.kind = 'read_pass' AND e.status = 'active'
      AND e.valid_from <= ? AND e.valid_until > ? AND sc.status = 'published'
    ORDER BY e.valid_until ASC, sc.title ASC
  `).bind(actor.user.id, now, now).all<Record<string, unknown>>()
  return context.json({ scopes: scopes.results })
})

app.get('/api/verifier/scopes/:scopeId', async (context) => {
  const actor = await currentSession(platformContext(context))
  if (actor.user.role !== 'verifier') throw new AuthorizationError('Verifier access required', 403, 'verifier_required')
  const service = new VerifierService(requestDatabase(context))
  const scopeId = context.req.param('scopeId')
  return context.json({
    scope: await service.paidScope(actor.user.id, scopeId),
    events: await service.paidEvents(actor.user.id, scopeId),
  })
})

async function availableShareScopes(database: D1Database, ownerId: string): Promise<Record<string, unknown>[]> {
  const [published, humanCases] = await Promise.all([
    database.prepare(`
      SELECT id, title, scope_type, scope_ref, status
      FROM evidence_scopes WHERE owner_id = ? AND status = 'published'
      ORDER BY published_at DESC, created_at DESC
    `).bind(ownerId).all<Record<string, unknown>>(),
    database.prepare(`
      SELECT 'case:' || c.id AS id, c.title, 'case' AS scope_type,
             c.case_ref AS scope_ref, 'ready_to_publish' AS status
      FROM cases c
      WHERE c.owner_id = ? AND EXISTS (SELECT 1 FROM events e WHERE e.case_id = c.id)
        AND NOT EXISTS (
          SELECT 1 FROM evidence_scopes sc
          WHERE sc.owner_id = c.owner_id AND sc.scope_type = 'case'
            AND sc.scope_ref = c.case_ref AND sc.status = 'published'
        )
      ORDER BY c.updated_at DESC
    `).bind(ownerId).all<Record<string, unknown>>(),
  ])
  return [...published.results, ...humanCases.results]
}

app.get('/api/shares', async (context) => {
  const actor = await currentSession(platformContext(context))
  if (actor.user.role !== 'supplier') return context.json({ shares: [], available_scopes: [] })
  const database = requestDatabase(context)
  const shares = await database.prepare(`
    SELECT s.id, s.scope_id, sc.title AS scope_title, s.token_prefix, s.include_pdf,
           s.status, s.max_views, s.view_count, s.expires_at, s.revoked_at,
           s.last_accessed_at, s.created_at
    FROM shares s JOIN evidence_scopes sc ON sc.id = s.scope_id
    WHERE s.owner_id = ? ORDER BY s.created_at DESC LIMIT 100
  `).bind(actor.user.id).all<Record<string, unknown>>()
  return context.json({ shares: shares.results, available_scopes: await availableShareScopes(database, actor.user.id) })
})

async function resolveShareScope(database: D1Database, actor: SessionActor, requested: string): Promise<string> {
  if (!requested.startsWith('case:')) return requested
  const caseId = requested.slice('case:'.length)
  const humanCase = await database.prepare(`
    SELECT id, case_ref, title, description FROM cases WHERE id = ? AND owner_id = ? LIMIT 1
  `).bind(caseId, actor.user.id).first<{ id: string; case_ref: string; title: string; description: string | null }>()
  if (!humanCase) throw new DomainError(404, 'case_not_found', 'Case not found')
  const service = new VerifierService(database)
  let scope = await database.prepare(`
    SELECT id, status FROM evidence_scopes
    WHERE owner_id = ? AND scope_type = 'case' AND scope_ref = ? LIMIT 1
  `).bind(actor.user.id, humanCase.case_ref).first<{ id: string; status: string }>()
  if (!scope) {
    const eventRows = await database.prepare(`
      SELECT id FROM events WHERE owner_id = ? AND case_id = ? ORDER BY position ASC
    `).bind(actor.user.id, humanCase.id).all<{ id: string }>()
    const created = await service.createScope(actor.user.id, {
      scope_type: 'case',
      scope_ref: humanCase.case_ref,
      title: humanCase.title,
      summary: humanCase.description,
      event_ids: eventRows.results.map((event) => event.id),
    })
    scope = { id: created.id, status: created.status }
  }
  if (scope.status === 'draft') await service.publishScope(actor.user.id, scope.id)
  else if (scope.status !== 'published') throw new DomainError(409, 'scope_not_publishable', 'This evidence scope cannot be shared')
  return scope.id
}

app.post('/api/shares', async (context) => {
  const actor = await requireSupplier(context)
  await assertSessionMutation(platformContext(context), actor)
  if (!activeEntitlement(actor, 'writer_plan')) {
    throw new AuthorizationError('An active supplier plan is required', 402, 'entitlement_required')
  }
  const body = requirePlainRecord(await context.req.json(), 'share')
  if (typeof body.scope_id !== 'string' || !body.scope_id.trim()) {
    throw new ValidationError('scope_id is required', 'required', 'scope_id')
  }
  const days = Number(body.expires_days ?? 30)
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new ValidationError('expires_days must be 1-365', 'invalid_expiry', 'expires_days')
  }
  const database = requestDatabase(context)
  const scopeId = await resolveShareScope(database, actor, body.scope_id.trim())
  const created = await new VerifierService(database).createShare(actor.user.id, scopeId, {
    expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    include_pdf: true,
    max_views: body.max_views == null || body.max_views === '' ? null : Number(body.max_views),
  })
  return context.json({
    ...created,
    share_url: `${applicationOrigin(context)}/verify/${encodeURIComponent(created.token)}`,
  }, 201)
})

app.get('/api/public/shares/:token', async (context) => {
  return context.json(await new VerifierService(requestDatabase(context)).resolveShare(context.req.param('token')))
})

app.get('/api/public/shares/:token/events/:eventId/proof', async (context) => {
  const service = new VerifierService(requestDatabase(context))
  const shared = await service.resolveShare(context.req.param('token'))
  return context.json(await service.portableProof(context.req.param('eventId'), undefined, shared.scope.id))
})

app.get('/api/public/shares/:token/events/:eventId/proof.pdf', async (context) => {
  const service = new VerifierService(requestDatabase(context))
  const shared = await service.resolveShare(context.req.param('token'))
  if (!shared.include_pdf) throw new DomainError(403, 'pdf_not_shared', 'This share does not include PDF export')
  const proof = await service.portableProof(context.req.param('eventId'), undefined, shared.scope.id)
  return createProofPdfResponse(proof)
})

app.get('/api/events/:eventId/proof', async (context) => {
  const actor = await requireSupplier(context)
  return context.json(await new VerifierService(requestDatabase(context)).portableProof(
    context.req.param('eventId'),
    actor.user.id,
  ))
})

app.get('/api/events/:eventId/proof.pdf', async (context) => {
  const actor = await requireSupplier(context)
  const proof = await new VerifierService(requestDatabase(context)).portableProof(
    context.req.param('eventId'),
    actor.user.id,
  )
  return createProofPdfResponse(proof)
})

async function billingPortal(context: WorkerContext, idempotencyPrefix: string): Promise<string> {
  const actor = await currentSession(platformContext(context))
  await assertSessionMutation(platformContext(context), actor)
  const row = await requestDatabase(context).prepare(
    'SELECT stripe_customer_id FROM users WHERE id = ? LIMIT 1',
  ).bind(actor.user.id).first<{ stripe_customer_id: string | null }>()
  if (!row?.stripe_customer_id) {
    throw new DomainError(409, 'billing_customer_missing', 'No Stripe billing profile is linked to this account')
  }
  const portal = await stripeClient(context.env).createBillingPortalSession({
    customerId: row.stripe_customer_id,
    returnUrl: `${applicationOrigin(context)}/app#billing`,
    environment: context.env.ENV,
    idempotencyKey: `${idempotencyPrefix}_${actor.user.id}_${Date.now()}`,
  })
  return portal.url
}

app.post('/api/billing/portal', async (context) => {
  return context.json({ portal_url: await billingPortal(context, 'billing_portal') })
})

app.post('/api/billing/checkout', async (context) => {
  const actor = await currentSession(platformContext(context))
  if (actor.user.role !== 'supplier') throw new AuthorizationError('Supplier access required', 403, 'supplier_required')
  return context.json({
    checkout_url: await billingPortal(context, 'billing_change'),
    managed_by: 'stripe_billing_portal',
  })
})

app.get('/api/anchors/priority', async (context) => {
  const actor = await requireSupplier(context)
  const requests = await requestDatabase(context).prepare(`
    SELECT id, event_type_ref, range_start, range_end, status, anchor_batch_id,
           last_error, created_at, completed_at
    FROM priority_anchor_requests WHERE supplier_user_id = ?
    ORDER BY created_at DESC LIMIT 100
  `).bind(actor.user.id).all<Record<string, unknown>>()
  return context.json({ requests: requests.results })
})

app.post('/api/anchors/priority', async (context) => {
  const actor = await requireSupplier(context)
  await assertSessionMutation(platformContext(context), actor)
  if (!actor.entitlements.some((entitlement) => entitlement.kind === 'writer_plan' && entitlement.status === 'active')) {
    throw new AuthorizationError('An active Supplier plan is required', 402, 'active_plan_required')
  }
  const body = requirePlainRecord(await context.req.json(), 'priority anchor request')
  const eventTypeRef = requireString(body.event_type_ref ?? body.event_type, 'event_type_ref', { max: 128 })
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(eventTypeRef)) throw new ValidationError('event_type_ref is invalid', 'invalid_event_type_ref', 'event_type_ref')
  const start = new Date(requireString(body.range_start, 'range_start', { max: 64 }))
  const end = new Date(requireString(body.range_end, 'range_end', { max: 64 }))
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || start >= end) {
    throw new ValidationError('range_start and range_end must be a valid end-exclusive range', 'invalid_access_range')
  }
  const database = requestDatabase(context)
  const catalog = await database.prepare(`SELECT id FROM supplier_event_types WHERE owner_id = ? AND event_type_ref = ? AND status = 'active' LIMIT 1`)
    .bind(actor.user.id, eventTypeRef).first<{ id: string }>()
  if (!catalog) throw new DomainError(404, 'event_type_not_found', 'Active event type not found')
  const event = await database.prepare(`
    SELECT 1 FROM events WHERE owner_id = ? AND event_type_id = ?
      AND COALESCE(occurred_at, received_at) >= ? AND COALESCE(occurred_at, received_at) < ? LIMIT 1
  `).bind(actor.user.id, catalog.id, start.toISOString(), end.toISOString()).first()
  if (!event) throw new DomainError(404, 'event_range_empty', 'No matching Supplier events exist in this range')
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  await database.prepare(`
    INSERT INTO priority_anchor_requests (
      id, requested_by_user_id, supplier_user_id, event_type_id, event_type_ref,
      access_order_id, range_start, range_end, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'pending', ?, ?)
  `).bind(id, actor.user.id, actor.user.id, catalog.id, eventTypeRef, start.toISOString(), end.toISOString(), createdAt, createdAt).run()
  return context.json({ id, event_type_ref: eventTypeRef, range_start: start.toISOString(), range_end: end.toISOString(), status: 'pending' }, 202)
})

async function fulfillAccessCheckout(database: D1Database, environment: Env['ENV'], event: StripeEvent): Promise<boolean> {
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return false
  const session = event.data.object
  if (session.object !== 'checkout.session' || session.payment_status !== 'paid') return false
  const rawMetadata = session.metadata
  if (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) return false
  const metadata = rawMetadata as Record<string, unknown>
  if (metadata.billing_kind !== 'outdock_access') return false
  if (metadata.environment !== environment || typeof metadata.access_order_id !== 'string') {
    throw new StripeWebhookError('Access Checkout metadata is invalid', 'invalid_checkout_metadata')
  }
  const order = await database.prepare(`
    SELECT o.*, f.supplier_user_id, i.verifier_organization_id
    FROM access_orders o JOIN access_offers f ON f.id = o.offer_id
    JOIN verifier_invitations i ON i.id = f.invitation_id
    WHERE o.id = ? AND o.environment = ? LIMIT 1
  `).bind(metadata.access_order_id, environment).first<Record<string, any>>()
  if (!order) throw new StripeWebhookError('Access order was not found', 'access_order_not_found')
  if (order.status === 'fulfilled') return true
  if (order.status !== 'checkout_created' || order.stripe_checkout_session_id !== session.id || metadata.access_model !== order.access_model) {
    throw new StripeWebhookError('Access Checkout does not match the order', 'checkout_order_mismatch')
  }
  if (session.currency !== 'usd' || session.amount_total !== order.amount_cents) {
    throw new StripeWebhookError('Access Checkout amount does not match the server quote', 'checkout_amount_mismatch')
  }
  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null
  if (order.access_model === 'one_time_range' && !paymentIntentId) throw new StripeWebhookError('PaymentIntent is missing', 'checkout_payment_missing')
  if (order.access_model === 'subscription_28d' && !subscriptionId) throw new StripeWebhookError('Subscription is missing', 'checkout_subscription_missing')

  const paidAt = new Date(event.created * 1000)
  const quote = order.access_model === 'subscription_28d' ? quoteSubscriptionWindow(paidAt) : null
  const dataFrom = quote?.rangeStart ?? order.range_start
  const dataUntil = quote?.rangeEnd ?? order.range_end
  const accessFrom = paidAt.toISOString()
  const accessUntil = order.access_model === 'subscription_28d' ? dataUntil : '9999-12-31T23:59:59.999Z'
  const futureUntil = order.access_model === 'subscription_28d' ? dataUntil : null
  const grantId = crypto.randomUUID()
  const now = new Date().toISOString()
  await database.batch([
    database.prepare(`
      INSERT INTO access_grants (
        id, access_order_id, verifier_user_id, verifier_organization_id,
        supplier_user_id, event_type_id, access_model, data_from, data_until,
        access_from, access_until, include_future_until, status, created_at, updated_at
      ) SELECT ?, id, verifier_user_id, ?, ?, event_type_id, access_model, ?, ?, ?, ?, ?, 'active', ?, ?
        FROM access_orders WHERE id = ? AND status = 'checkout_created'
    `).bind(grantId, order.verifier_organization_id, order.supplier_user_id, dataFrom, dataUntil,
      accessFrom, accessUntil, futureUntil, now, now, order.id),
    database.prepare(`
      UPDATE access_orders SET status = 'fulfilled', range_start = ?, range_end = ?,
        stripe_payment_intent_id = ?, stripe_subscription_id = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'checkout_created'
        AND EXISTS (SELECT 1 FROM access_grants WHERE id = ? AND access_order_id = ?)
    `).bind(dataFrom, dataUntil, paymentIntentId, subscriptionId, now, now, order.id, grantId, order.id),
    database.prepare(`
      INSERT INTO priority_anchor_requests (
        id, requested_by_user_id, supplier_user_id, event_type_id, event_type_ref,
        access_order_id, range_start, range_end, status, created_at, updated_at
      ) SELECT ?, verifier_user_id, ?, event_type_id, t.event_type_ref, id, ?, ?, 'pending', ?, ?
        FROM access_orders JOIN supplier_event_types t ON t.id = access_orders.event_type_id
        WHERE access_orders.id = ? AND access_orders.status IN ('checkout_created', 'fulfilled')
    `).bind(crypto.randomUUID(), order.supplier_user_id, dataFrom, dataUntil, now, now, order.id),
  ])
  const completed = await database.prepare('SELECT 1 FROM access_orders WHERE id = ? AND status = \'fulfilled\' LIMIT 1').bind(order.id).first()
  if (!completed) throw new StripeWebhookError('Access fulfillment did not complete atomically', 'access_fulfillment_incomplete')
  return true
}

app.post('/api/webhooks/stripe', async (context) => {
  const rawBody = await context.req.text()
  const database = requestDatabase(context)
  const stripe = stripeClient(context.env)
  const legacyHandler = createD1BillingEventHandler(database, { environment: context.env.ENV, stripe })
  const result = await processStripeWebhook(rawBody, {
    secrets: required(context.env, 'STRIPE_WEBHOOK_SECRET').split(',').map((secret) => secret.trim()).filter(Boolean),
    signatureHeader: context.req.header('Stripe-Signature') || '',
    environment: context.env.ENV,
    store: createD1StripeWebhookStore(database),
    handle: async (event) => {
      if (!await fulfillAccessCheckout(database, context.env.ENV, event)) await legacyHandler(event)
    },
  })
  return context.json({ received: true, ...result })
})

app.notFound((context) => context.json({
  error: 'Not found',
  code: 'not_found',
  request_id: requestId(context),
}, 404))

async function runAnchoring(environment: Env): Promise<void> {
  if (!environment.BASE_RPC_URL || !environment.BASE_PRIVATE_KEY) return
  const contractAddress = environment.ENV === 'prod'
    ? environment.BASE_CONTRACT_ADDRESS_PROD
    : environment.BASE_CONTRACT_ADDRESS_DEV
  if (!contractAddress) return
  const provider = new JsonRpcProvider(
    environment.BASE_RPC_URL,
    Number(environment.ENV === 'prod' ? environment.BASE_CHAIN_ID_PROD : environment.BASE_CHAIN_ID_DEV),
    { staticNetwork: true },
  )
  const signer = new Wallet(environment.BASE_PRIVATE_KEY, provider)
  const contract = new Contract(contractAddress, [
    'function anchorBatch(bytes4 protocolId, bytes32 batchId, bytes32 merkleRoot, bytes32 manifestHash, uint32 leafCount, uint32 eventCount) returns (uint256)',
  ], signer) as unknown as EthersAnchorContractLike
  const anchorClient = {
    ...createEthersAnchorClient(contract, environment.OUTDOCK_ANCHOR_PROTOCOL_ID || '0x4f443100'),
    async transactionStatus(transactionHash: string) {
      const receipt = await provider.getTransactionReceipt(transactionHash)
      if (receipt) {
        return {
          state: receipt.status === 1 ? 'confirmed' as const : 'failed' as const,
          receipt: {
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
          },
        }
      }
      return {
        state: await provider.getTransaction(transactionHash) ? 'pending' as const : 'missing' as const,
      }
    },
  }
  const service = new PolygonAnchorService(
    databaseFor(environment),
    anchorClient,
    {
      environment: environment.ENV,
      chainId: environment.ENV === 'prod' ? environment.BASE_CHAIN_ID_PROD : environment.BASE_CHAIN_ID_DEV,
      network: environment.ENV === 'prod' ? 'base' : 'base-sepolia',
      contractAddress,
      batchSize: 500,
      confirmations: Number(environment.BASE_CONFIRMATIONS || 3),
    },
  )
  await service.runScheduled()
}

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, environment: Env, execution: ExecutionContext) {
    execution.waitUntil(runAnchoring(environment))
  },
}
