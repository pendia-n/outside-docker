import { Hono } from 'hono'
import { DomainError } from './chain-do'

export interface EventCatalogActor {
  userId: string
  role: 'supplier' | 'verifier'
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

function required(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new DomainError(400, 'invalid_request', `${field} is required and must be at most ${maximum} characters`)
  }
  return value.trim()
}

function reference(value: unknown, field: string): string {
  const normalized = required(value, field, 128)
  if (!REFERENCE.test(normalized)) throw new DomainError(400, 'invalid_reference', `${field} contains unsupported characters`)
  return normalized
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value == null || value === '') return null
  return required(value, field, maximum)
}

function uniqueFailure(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message)
}

export class EventCatalogService {
  constructor(private readonly database: D1Database, private readonly now: () => Date = () => new Date()) {}

  async listTypes(ownerId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.database.prepare(`
      SELECT t.id, t.event_type_ref, t.name, t.description, t.status, t.created_at, t.updated_at,
             (SELECT COUNT(*) FROM event_instances i WHERE i.event_type_id = t.id) AS instance_count,
             (SELECT COUNT(*) FROM events e WHERE e.event_type_id = t.id) AS record_count
      FROM supplier_event_types t WHERE t.owner_id = ?
      ORDER BY CASE t.status WHEN 'active' THEN 0 ELSE 1 END, t.name, t.id
    `).bind(ownerId).all<Record<string, unknown>>()
    return rows.results
  }

  async createType(ownerId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const eventTypeRef = reference(input.event_type_ref, 'event_type_ref')
    const name = required(input.name, 'name', 160)
    const description = optionalText(input.description, 'description', 1000)
    const organization = await this.database.prepare('SELECT id FROM organizations WHERE user_id = ? LIMIT 1')
      .bind(ownerId).first<{ id: string }>()
    const id = crypto.randomUUID()
    const timestamp = this.now().toISOString()
    try {
      await this.database.prepare(`
        INSERT INTO supplier_event_types (
          id, owner_id, organization_id, event_type_ref, name, description, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).bind(id, ownerId, organization?.id ?? null, eventTypeRef, name, description, timestamp, timestamp).run()
    } catch (error) {
      if (uniqueFailure(error)) throw new DomainError(409, 'event_type_ref_conflict', 'event_type_ref already exists')
      throw error
    }
    return { id, event_type_ref: eventTypeRef, name, description, status: 'active', created_at: timestamp, updated_at: timestamp }
  }

  async createInstance(ownerId: string, eventTypeRef: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const eventType = await this.database.prepare(`
      SELECT id FROM supplier_event_types WHERE owner_id = ? AND event_type_ref = ? AND status = 'active' LIMIT 1
    `).bind(ownerId, reference(eventTypeRef, 'event_type_ref')).first<{ id: string }>()
    if (!eventType) throw new DomainError(404, 'event_type_not_found', 'Active event type not found')
    const instanceRef = reference(input.instance_ref, 'instance_ref')
    const title = optionalText(input.title, 'title', 160)
    const startedAt = input.started_at == null || input.started_at === '' ? null : new Date(String(input.started_at))
    if (startedAt && !Number.isFinite(startedAt.valueOf())) throw new DomainError(400, 'invalid_started_at', 'started_at must be ISO-8601')
    const id = crypto.randomUUID()
    const timestamp = this.now().toISOString()
    try {
      await this.database.prepare(`
        INSERT INTO event_instances (
          id, owner_id, event_type_id, instance_ref, title, status, started_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).bind(id, ownerId, eventType.id, instanceRef, title, startedAt?.toISOString() ?? null, timestamp, timestamp).run()
    } catch (error) {
      if (uniqueFailure(error)) throw new DomainError(409, 'instance_ref_conflict', 'instance_ref already exists for this event type')
      throw error
    }
    return { id, event_type_id: eventType.id, instance_ref: instanceRef, title, status: 'active', started_at: startedAt?.toISOString() ?? null }
  }

  async listInstances(ownerId: string, eventTypeRef: string): Promise<Record<string, unknown>[]> {
    const rows = await this.database.prepare(`
      SELECT i.id, i.instance_ref, i.title, i.status, i.started_at, i.ended_at,
             (SELECT COUNT(*) FROM events e WHERE e.event_instance_id = i.id) AS record_count
      FROM event_instances i JOIN supplier_event_types t ON t.id = i.event_type_id
      WHERE i.owner_id = ? AND t.event_type_ref = ? ORDER BY i.created_at DESC
    `).bind(ownerId, reference(eventTypeRef, 'event_type_ref')).all<Record<string, unknown>>()
    return rows.results
  }
}

export function createEventCatalogRoutes(dependencies: {
  database(context: any): D1Database
  authenticate(context: any): Promise<EventCatalogActor | null>
  authorizeWrite(actor: EventCatalogActor, context: any): Promise<void>
}): Hono {
  const routes = new Hono()
  const actor = async (context: any, write = false) => {
    const authenticated = await dependencies.authenticate(context)
    if (!authenticated) throw new DomainError(401, 'authentication_required', 'Login required')
    if (authenticated.role !== 'supplier') throw new DomainError(403, 'supplier_required', 'Supplier access required')
    if (write) await dependencies.authorizeWrite(authenticated, context)
    return authenticated
  }
  const service = (context: any) => new EventCatalogService(dependencies.database(context))
  routes.get('/event-types', async (context) => context.json({ event_types: await service(context).listTypes((await actor(context)).userId) }))
  routes.post('/event-types', async (context) => context.json(await service(context).createType((await actor(context, true)).userId, await context.req.json()), 201))
  routes.get('/event-types/:eventTypeRef/instances', async (context) => context.json({ instances: await service(context).listInstances((await actor(context)).userId, context.req.param('eventTypeRef')) }))
  routes.post('/event-types/:eventTypeRef/instances', async (context) => context.json(await service(context).createInstance((await actor(context, true)).userId, context.req.param('eventTypeRef'), await context.req.json()), 201))
  return routes
}
