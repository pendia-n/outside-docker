import { describe, expect, it } from 'vitest'
import { app } from '../src/index'

const env = { APP_ENV: 'development', API_KEY_PEPPER: 'synthetic-only', DEV_API_KEY: 'dev-human-key' }

async function post(path: string, body: unknown, idempotencyKey: string, key = env.DEV_API_KEY) {
  return app.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) }), env as never)
}

describe('Track H and Track M append API', () => {
  it('appends human events and returns the same receipt on idempotent replay', async () => {
    const first = await post('/event', { case_ref: 'synthetic-case-1', event_type: 'DOCUMENT_RECEIVED', metadata: { source: 'fixture' }, chain_secret: 'synthetic-chain-secret' }, 'idempotent-h-1')
    expect(first.status).toBe(201)
    const firstJson = await first.json() as { proof: string; chain_position: number }
    expect(firstJson.chain_position).toBe(1)
    const replay = await post('/event', { case_ref: 'synthetic-case-1', event_type: 'DOCUMENT_RECEIVED', metadata: { source: 'fixture' }, chain_secret: 'synthetic-chain-secret' }, 'idempotent-h-1')
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ proof: firstJson.proof, chain_position: 1, idempotent_replay: true })
  })

  it('requires machine-only credentials for Track M', async () => {
    const response = await post('/record', { source: 'synthetic-robot', action: 'MOVE', params: { x: 1 }, chain_secret: 'synthetic-chain-secret' }, 'machine-1')
    expect(response.status).toBe(403)
  })
})
