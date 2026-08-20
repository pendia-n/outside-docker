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
} from './billing'
import { DomainError, createChainDurableObject, durableObjectChainAppender } from './chain-do'
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
import { ValidationError, requirePlainRecord } from './validation'
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
const MAX_REQUEST_BYTES = 2_200_000

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
app.get('/app', (context) => context.render(<ApplicationPage />))
app.get('/verify', (context) => context.render(<VerifyPage />))
app.get('/verify/:token', (context) => context.render(<VerifyPage shareToken={context.req.param('token')} />))
app.get('/checkout/success', (context) => context.render(<CheckoutStatusPage state="success" />))
app.get('/checkout/cancelled', (context) => context.render(<CheckoutStatusPage state="cancelled" />))

app.get('/health', (context) => context.json({
  ok: true,
  app: 'outside-docker',
  environment: context.env.ENV,
  database: context.env.ENV === 'prod' ? 'DB_PROD' : 'DB_DEV',
  polygon_chain_id: context.env.POLYGON_CHAIN_ID,
}))

app.route('/api', createAccountRoutes())

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
      ? required(environment, 'POLYGON_CONTRACT_ADDRESS_PROD')
      : required(environment, 'POLYGON_CONTRACT_ADDRESS_DEV')
    if (
      anchor.chain_id !== environment.POLYGON_CHAIN_ID
      || anchor.contract_address.toLowerCase() !== configuredAddress.toLowerCase()
      || !environment.POLYGON_RPC_URL
    ) return false
    const provider = new JsonRpcProvider(
      environment.POLYGON_RPC_URL,
      Number(environment.POLYGON_CHAIN_ID),
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

app.post('/api/webhooks/stripe', async (context) => {
  const rawBody = await context.req.text()
  const database = requestDatabase(context)
  const stripe = stripeClient(context.env)
  const result = await processStripeWebhook(rawBody, {
    secrets: required(context.env, 'STRIPE_WEBHOOK_SECRET').split(',').map((secret) => secret.trim()).filter(Boolean),
    signatureHeader: context.req.header('Stripe-Signature') || '',
    environment: context.env.ENV,
    store: createD1StripeWebhookStore(database),
    handle: createD1BillingEventHandler(database, { environment: context.env.ENV, stripe }),
  })
  return context.json({ received: true, ...result })
})

app.notFound((context) => context.json({
  error: 'Not found',
  code: 'not_found',
  request_id: requestId(context),
}, 404))

async function runAnchoring(environment: Env): Promise<void> {
  if (!environment.POLYGON_RPC_URL || !environment.POLYGON_PRIVATE_KEY) return
  const contractAddress = environment.ENV === 'prod'
    ? environment.POLYGON_CONTRACT_ADDRESS_PROD
    : environment.POLYGON_CONTRACT_ADDRESS_DEV
  if (!contractAddress) return
  const provider = new JsonRpcProvider(
    environment.POLYGON_RPC_URL,
    Number(environment.POLYGON_CHAIN_ID),
    { staticNetwork: true },
  )
  const signer = new Wallet(environment.POLYGON_PRIVATE_KEY, provider)
  const contract = new Contract(contractAddress, [
    'function anchorBatch(bytes32 batchId, bytes32 merkleRoot, bytes32 manifestHash, uint32 leafCount, uint32 eventCount) returns (uint256)',
  ], signer) as unknown as EthersAnchorContractLike
  const anchorClient = {
    ...createEthersAnchorClient(contract),
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
      chainId: environment.POLYGON_CHAIN_ID,
      network: environment.ENV === 'prod' ? 'polygon' : 'polygon-amoy',
      contractAddress,
      batchSize: 500,
      confirmations: Number(environment.POLYGON_CONFIRMATIONS || 3),
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
