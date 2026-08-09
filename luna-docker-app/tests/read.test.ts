import { describe, expect, it } from 'vitest'
import { app } from '../src/index'

const env = { APP_ENV: 'development', API_KEY_PEPPER: 'read-test-pepper', DEV_API_KEY: 'read-human-key', DEV_MACHINE_API_KEY: 'read-machine-key', NETWORK_NAME: 'polygon-amoy' }

async function postEvent(key: string, idempotencyKey: string) {
  return app.fetch(new Request('http://localhost/event', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ case_ref: 'read-case-1', event_type: 'RECEIVED', metadata: { fixture: true }, chain_secret: 'synthetic-chain-secret' }) }), env as never)
}

describe('read and verification routes', () => {
  it('returns a chain without private ciphertext', async () => {
    await postEvent(env.DEV_API_KEY, 'read-chain-1')
    const response = await app.fetch(new Request('http://localhost/case/read-case-1/chain', { headers: { Authorization: `Bearer ${env.DEV_API_KEY}` } }), env as never)
    expect(response.status).toBe(200)
    const json = await response.json() as { chain_integrity: boolean; events: Array<Record<string, unknown>> }
    expect(json.chain_integrity).toBe(true)
    expect(json.events[0]).not.toHaveProperty('ciphertext')
  })

  it('returns public verification JSON and printable HTML', async () => {
    const response = await postEvent(env.DEV_API_KEY, 'read-public-1')
    const json = await response.json() as { proof: string }
    const publicJson = await app.fetch(new Request(`http://localhost/verify/public/${json.proof}`, { headers: { Accept: 'application/json' } }), env as never)
    expect(publicJson.status).toBe(200)
    expect((await publicJson.json() as { chain_integrity: boolean }).chain_integrity).toBe(true)
    const html = await app.fetch(new Request(`http://localhost/verify/public/${json.proof}`, { headers: { Accept: 'text/html' } }), env as never)
    expect(html.headers.get('content-type')).toContain('text/html')
    expect(await html.text()).toContain('CHECKPOINT PENDING')
  })

  it('accepts machine writes only with the machine key', async () => {
    const response = await app.fetch(new Request('http://localhost/record', { method: 'POST', headers: { Authorization: `Bearer ${env.DEV_MACHINE_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'read-machine-1' }, body: JSON.stringify({ source: 'read-robot', action: 'MOVE', params: { x: 1 }, chain_secret: 'synthetic-chain-secret' }) }), env as never)
    expect(response.status).toBe(201)
  })
})
