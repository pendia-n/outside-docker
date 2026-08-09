import { describe, expect, it } from 'vitest'
import { app } from '../src/index'

const env = { APP_ENV: 'development', API_KEY_PEPPER: 'anchor-pepper', DEV_API_KEY: 'anchor-human', ANCHOR_SERVICE_SECRET: 'anchor-service', NETWORK_NAME: 'polygon-amoy', CHAIN_ID: '80002' }

describe('development checkpoint anchor', () => {
  it('persists a local checkpoint but does not claim blockchain confirmation', async () => {
    const write = await app.fetch(new Request('http://localhost/event', { method: 'POST', headers: { Authorization: 'Bearer anchor-human', 'Content-Type': 'application/json', 'Idempotency-Key': 'anchor-event-1' }, body: JSON.stringify({ case_ref: 'anchor-case', event_type: 'CAPTURED', chain_secret: 'synthetic-chain-secret' }) }), env as never)
    const event = await write.json() as { proof: string }
    const chain = await app.fetch(new Request('http://localhost/case/anchor-case/chain', { headers: { Authorization: 'Bearer anchor-human' } }), env as never)
    const chainJson = await chain.json() as { chain_id: string; events: Array<{ proof: string }> }
    const anchor = await app.fetch(new Request('http://localhost/anchor', { method: 'POST', headers: { 'X-Anchor-Service-Secret': 'anchor-service', 'Content-Type': 'application/json' }, body: JSON.stringify({ chain_id: chainJson.chain_id }) }), env as never)
    expect(anchor.status).toBe(202)
    expect((await anchor.json() as { anchor: { status: string } }).anchor.status).toBe('pending')
    expect(chainJson.events[0]?.proof).toBe(event.proof)
  })
})
