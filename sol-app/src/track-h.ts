import { Hono } from 'hono'
import { canonicalSha256 } from './canonical'
import { DomainError, type ChainAppendResult, type ChainAppender } from './chain-do'

export interface TrackHActor {
  userId: string
  role: 'supplier' | 'verifier'
  sessionId: string
}

export interface HumanCase {
  id: string
  owner_id: string
  organization_id: string | null
  chain_id: string | null
  case_ref: string
  title: string
  description: string | null
  category: string | null
  status: string
  created_at: string
  updated_at: string
  closed_at: string | null
  event_count?: number
}

export interface CreateCaseInput {
  case_ref: string
  title: string
  description?: string | null
  category?: string | null
}

export interface HumanEventInput {
  event_type: string
  event_type_ref?: string | null
  event_instance_ref?: string | null
  commitment: string
  manifest_hash: string
  occurred_at?: string | null
  metadata?: unknown
  idempotency_key?: string
}

export interface HumanCorrectionInput extends HumanEventInput {
  correction_reason?: string
}

const CASE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const FORBIDDEN_CONTENT_KEYS = new Set([
  'encrypted_capsule',
  'passcode',
  'password',
  'original',
  'original_content',
  'file',
  'file_bytes',
  'content_base64',
  'raw_bytes',
  'local_path',
])

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum) {
    throw new DomainError(400, 'invalid_request', `${field} is required and must be at most ${maximum} characters`)
  }
  return value.trim()
}

export function assertNoRetainedPayload(value: unknown, path = '$'): void {
  if (value == null || typeof value !== 'object') return
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob) {
    throw new DomainError(400, 'original_content_rejected', `Binary content is not accepted at ${path}`)
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRetainedPayload(item, `${path}[${index}]`))
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONTENT_KEYS.has(key.toLowerCase())) {
      throw new DomainError(400, 'original_content_rejected', `${key} must remain in the browser and is not accepted by the Worker`)
    }
    assertNoRetainedPayload(child, `${path}.${key}`)
  }
}

export function validateCaseInput(input: CreateCaseInput): Required<Omit<CreateCaseInput, 'description' | 'category'>> & Pick<CreateCaseInput, 'description' | 'category'> {
  const caseRef = text(input.case_ref, 'case_ref', 128)
  if (!CASE_REFERENCE.test(caseRef)) throw new DomainError(400, 'invalid_case_ref', 'case_ref contains unsupported characters')
  return {
    case_ref: caseRef,
    title: text(input.title, 'title', 160),
    description: input.description == null ? null : text(input.description, 'description', 1000),
    category: input.category == null ? null : text(input.category, 'category', 80),
  }
}

function isUniqueFailure(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message)
}

export class TrackHService {
  constructor(
    private readonly database: D1Database,
    private readonly chainAppender: ChainAppender,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createCase(ownerId: string, input: CreateCaseInput): Promise<HumanCase> {
    assertNoRetainedPayload(input)
    const value = validateCaseInput(input)
    const id = crypto.randomUUID()
    const createdAt = this.now().toISOString()
    const organization = await this.database.prepare(
      'SELECT id FROM organizations WHERE user_id = ? LIMIT 1',
    ).bind(ownerId).first<{ id: string }>()
    try {
      await this.database.prepare(`
        INSERT INTO cases (
          id, owner_id, organization_id, chain_id, case_ref, title, description,
          category, status, created_at, updated_at, closed_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'open', ?, ?, NULL)
      `).bind(id, ownerId, organization?.id ?? null, value.case_ref, value.title, value.description, value.category, createdAt, createdAt).run()
    } catch (error) {
      if (isUniqueFailure(error)) throw new DomainError(409, 'case_ref_conflict', 'case_ref already exists for this supplier')
      throw error
    }
    return {
      id,
      owner_id: ownerId,
      organization_id: organization?.id ?? null,
      chain_id: null,
      case_ref: value.case_ref,
      title: value.title,
      description: value.description ?? null,
      category: value.category ?? null,
      status: 'open',
      created_at: createdAt,
      updated_at: createdAt,
      closed_at: null,
    }
  }

  async listCases(ownerId: string): Promise<HumanCase[]> {
    const rows = await this.database.prepare(`
      SELECT id, owner_id, organization_id, chain_id, case_ref, title, description,
             category, status, created_at, updated_at, closed_at,
             (SELECT COUNT(*) FROM events WHERE events.case_id = cases.id) AS event_count
      FROM cases WHERE owner_id = ? ORDER BY updated_at DESC, id DESC
    `).bind(ownerId).all<HumanCase>()
    return rows.results
  }

  async getCase(ownerId: string, caseRef: string): Promise<HumanCase> {
    const row = await this.database.prepare(`
      SELECT id, owner_id, organization_id, chain_id, case_ref, title, description,
             category, status, created_at, updated_at, closed_at,
             (SELECT COUNT(*) FROM events WHERE events.case_id = cases.id) AS event_count
      FROM cases WHERE owner_id = ? AND case_ref = ? LIMIT 1
    `).bind(ownerId, caseRef).first<HumanCase>()
    if (!row) throw new DomainError(404, 'case_not_found', 'Case not found')
    return row
  }

  async listEvents(ownerId: string, caseRef: string): Promise<unknown[]> {
    const humanCase = await this.getCase(ownerId, caseRef)
    const rows = await this.database.prepare(`
      SELECT e.id, e.chain_id, e.position, e.event_type, e.commitment, e.manifest_hash,
             e.previous_proof, e.proof, e.occurred_at, e.received_at, e.corrects_event_id,
             e.anchor_status, e.anchor_batch_id, e.metadata_json,
             r.receipt_json, r.signature, r.signing_key_id, r.signature_algorithm
      FROM events e
      JOIN receipts r ON r.event_id = e.id
      WHERE e.owner_id = ? AND e.case_id = ? AND e.track = 'H'
      ORDER BY e.position ASC
    `).bind(ownerId, humanCase.id).all<Record<string, unknown>>()
    return rows.results
  }

  async appendEvent(
    actor: TrackHActor,
    caseRef: string,
    rawInput: HumanEventInput,
    correctionTarget?: string,
  ): Promise<ChainAppendResult> {
    assertNoRetainedPayload(rawInput)
    const humanCase = await this.getCase(actor.userId, caseRef)
    if (humanCase.status !== 'open') throw new DomainError(409, 'case_closed', 'Events cannot be appended to a closed case')
    if (!rawInput.idempotency_key) throw new DomainError(400, 'idempotency_required', 'Idempotency-Key is required')
    const requestHash = await canonicalSha256({ ...rawInput, case_ref: caseRef, correction_target: correctionTarget ?? null })
    let eventTypeId: string | null = null
    let eventInstanceId: string | null = null
    if (rawInput.event_type_ref) {
      const catalog = await this.database.prepare(`SELECT id FROM supplier_event_types WHERE owner_id = ? AND event_type_ref = ? AND status = 'active' LIMIT 1`)
        .bind(actor.userId, rawInput.event_type_ref).first<{ id: string }>()
      if (!catalog) throw new DomainError(404, 'event_type_not_found', 'Active event type not found')
      eventTypeId = catalog.id
      if (rawInput.event_instance_ref) {
        const instance = await this.database.prepare(`SELECT id FROM event_instances WHERE owner_id = ? AND event_type_id = ? AND instance_ref = ? AND status = 'active' LIMIT 1`)
          .bind(actor.userId, eventTypeId, rawInput.event_instance_ref).first<{ id: string }>()
        if (!instance) throw new DomainError(404, 'event_instance_not_found', 'Active event instance not found')
        eventInstanceId = instance.id
      }
    } else if (rawInput.event_instance_ref) {
      throw new DomainError(400, 'event_type_required', 'event_type_ref is required with event_instance_ref')
    }
    return this.chainAppender.append({
      ownerId: actor.userId,
      track: 'H',
      externalRef: humanCase.case_ref,
      eventType: rawInput.event_type,
      commitment: rawInput.commitment,
      manifestHash: rawInput.manifest_hash,
      occurredAt: rawInput.occurred_at,
      caseId: humanCase.id,
      eventTypeId,
      eventInstanceId,
      correctsEventId: correctionTarget ?? null,
      metadata: rawInput.metadata,
      credentialType: 'session',
      credentialId: actor.sessionId,
      idempotencyKey: rawInput.idempotency_key,
      requestHash,
    })
  }

  async appendCorrection(actor: TrackHActor, caseRef: string, eventId: string, input: HumanCorrectionInput): Promise<ChainAppendResult> {
    const metadata: Record<string, unknown> = {
      ...(input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {}),
    }
    if (input.correction_reason?.trim()) metadata.correction_reason = input.correction_reason.trim()
    return this.appendEvent(actor, caseRef, {
      ...input,
      event_type: input.event_type || 'CORRECTION_APPENDED',
      metadata,
    }, eventId)
  }
}

export interface TrackHRoutesDependencies {
  database(context: any): D1Database
  chainAppender(context: any): ChainAppender
  authenticate(context: any): Promise<TrackHActor | null>
  authorizeWrite(actor: TrackHActor, context: any): Promise<void>
}

function respondError(context: any, error: unknown) {
  if (error instanceof DomainError) return context.json({ error: error.message, code: error.code }, error.status)
  throw error
}

/** Mount under `/api/track-h`; all writes still pass through injected auth. */
export function createTrackHRoutes(dependencies: TrackHRoutesDependencies): Hono {
  const routes = new Hono()
  const actor = async (context: any, write = false): Promise<TrackHActor> => {
    const authenticated = await dependencies.authenticate(context)
    if (!authenticated) throw new DomainError(401, 'authentication_required', 'Login required')
    if (authenticated.role !== 'supplier') throw new DomainError(403, 'supplier_required', 'Supplier access required')
    if (write) await dependencies.authorizeWrite(authenticated, context)
    return authenticated
  }
  const service = (context: any) => new TrackHService(dependencies.database(context), dependencies.chainAppender(context))

  routes.post('/cases', async (context) => {
    try {
      const authenticated = await actor(context, true)
      return context.json(await service(context).createCase(authenticated.userId, await context.req.json()), 201)
    } catch (error) { return respondError(context, error) }
  })
  routes.get('/cases', async (context) => {
    try { return context.json({ cases: await service(context).listCases((await actor(context)).userId) }) }
    catch (error) { return respondError(context, error) }
  })
  routes.get('/cases/:caseRef', async (context) => {
    try { return context.json(await service(context).getCase((await actor(context)).userId, context.req.param('caseRef'))) }
    catch (error) { return respondError(context, error) }
  })
  routes.get('/cases/:caseRef/events', async (context) => {
    try { return context.json({ events: await service(context).listEvents((await actor(context)).userId, context.req.param('caseRef')) }) }
    catch (error) { return respondError(context, error) }
  })
  routes.post('/cases/:caseRef/events', async (context) => {
    try {
      const authenticated = await actor(context, true)
      const body = await context.req.json<HumanEventInput>()
      body.idempotency_key = context.req.header('Idempotency-Key') ?? body.idempotency_key
      return context.json(await service(context).appendEvent(authenticated, context.req.param('caseRef'), body), 201)
    } catch (error) { return respondError(context, error) }
  })
  routes.post('/cases/:caseRef/events/:eventId/corrections', async (context) => {
    try {
      const authenticated = await actor(context, true)
      const body = await context.req.json<HumanCorrectionInput>()
      body.idempotency_key = context.req.header('Idempotency-Key') ?? body.idempotency_key
      return context.json(await service(context).appendCorrection(authenticated, context.req.param('caseRef'), context.req.param('eventId'), body), 201)
    } catch (error) { return respondError(context, error) }
  })
  return routes
}
