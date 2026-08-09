import { Hono } from 'hono'
import { authenticate } from '../middleware/api-key'
import { getStore } from '../db'
import { appendEvent } from '../services/append-event'
import type { AppEnv } from '../index'

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

export const eventRoutes = new Hono<AppEnv>()

eventRoutes.post('/event', async (c) => {
  const auth = await authenticate(c)
  if (auth instanceof Response) return auth
  const key = c.req.header('Idempotency-Key')
  if (!key || key.length > 200) return c.json({ error: 'missing_idempotency_key' }, 400)
  const body = await c.req.json().catch(() => null) as unknown
  if (!isObject(body) || typeof body.case_ref !== 'string' || typeof body.event_type !== 'string' || typeof body.chain_secret !== 'string') return c.json({ error: 'invalid_event_payload' }, 400)
  try {
    const result = await appendEvent(getStore(c.env), { tenantId: auth.apiKey.tenantId, kind: 'human', externalRef: body.case_ref, chainSecret: body.chain_secret, idempotencyKey: key, payload: { case_ref: body.case_ref, event_type: body.event_type, file_hash: body.file_hash ?? null, metadata: body.metadata ?? null } })
    return c.json({ proof: result.event.proof, previous_proof: result.event.previousProof, chain_position: result.event.chainPosition, case_ref: body.case_ref, received_at: result.event.receivedAt, chain_integrity: true, idempotent_replay: result.replayed }, result.replayed ? 200 : 201)
  } catch (error) { return c.json({ error: 'append_failed', detail: error instanceof Error ? error.message : 'unknown error' }, 400) }
})

export const recordRoutes = new Hono<AppEnv>()

recordRoutes.post('/record', async (c) => {
  const auth = await authenticate(c, true)
  if (auth instanceof Response) return auth
  const key = c.req.header('Idempotency-Key')
  if (!key || key.length > 200) return c.json({ error: 'missing_idempotency_key' }, 400)
  const body = await c.req.json().catch(() => null) as unknown
  if (!isObject(body) || typeof body.source !== 'string' || typeof body.action !== 'string' || typeof body.chain_secret !== 'string') return c.json({ error: 'invalid_record_payload' }, 400)
  try {
    const result = await appendEvent(getStore(c.env), { tenantId: auth.apiKey.tenantId, kind: 'machine', externalRef: body.session_id ? `${body.source}:session:${String(body.session_id)}` : body.source, chainSecret: body.chain_secret, idempotencyKey: key, payload: { source: body.source, session_id: body.session_id ?? null, action: body.action, params: body.params ?? null, metadata: body.metadata ?? null } })
    return c.json({ proof: result.event.proof, previous_proof: result.event.previousProof, chain_position: result.event.chainPosition, source: body.source, action: body.action, received_at: result.event.receivedAt, chain_integrity: true, idempotent_replay: result.replayed }, result.replayed ? 200 : 201)
  } catch (error) { return c.json({ error: 'append_failed', detail: error instanceof Error ? error.message : 'unknown error' }, 400) }
})
