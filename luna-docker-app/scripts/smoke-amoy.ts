import { app } from '../src/index'

async function request(path: string, init: RequestInit, env: Record<string, string>) {
  const response = await app.fetch(new Request(`http://smoke.local${path}`, init), env as never)
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`)
  return { response, body: JSON.parse(text) as Record<string, unknown> }
}

async function main() {
  const env = { APP_ENV: 'development', API_KEY_PEPPER: 'smoke-pepper', DEV_API_KEY: 'smoke-human', DEV_MACHINE_API_KEY: 'smoke-machine', NETWORK_NAME: 'polygon-amoy' }
  const humanHeaders = { Authorization: 'Bearer smoke-human', 'Content-Type': 'application/json', 'Idempotency-Key': 'smoke-human-1' }
  const human = await request('/event', { method: 'POST', headers: humanHeaders, body: JSON.stringify({ case_ref: 'smoke-case', event_type: 'CAPTURED', metadata: { fixture: true }, chain_secret: 'smoke-chain-secret-strong' }) }, env)
  const replay = await request('/event', { method: 'POST', headers: { ...humanHeaders }, body: JSON.stringify({ case_ref: 'smoke-case', event_type: 'CAPTURED', metadata: { fixture: true }, chain_secret: 'smoke-chain-secret-strong' }) }, env)
  if (replay.body.proof !== human.body.proof || replay.body.idempotent_replay !== true) throw new Error('idempotency smoke failed')
  await request('/record', { method: 'POST', headers: { Authorization: 'Bearer smoke-machine', 'Content-Type': 'application/json', 'Idempotency-Key': 'smoke-machine-1' }, body: JSON.stringify({ source: 'smoke-robot', action: 'MOVE', params: { x: 1 }, chain_secret: 'smoke-chain-secret-strong' }) }, env)
  const verification = await request(`/verify/public/${String(human.body.proof)}`, { headers: { Accept: 'application/json' } }, env)
  if (verification.body.chain_integrity !== true) throw new Error('verification smoke failed')
  console.log(JSON.stringify({ ok: true, human_proof: human.body.proof, replay_safe: true, machine_recorded: true, public_chain_intact: true, blockchain_status: verification.body.status }, null, 2))
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
