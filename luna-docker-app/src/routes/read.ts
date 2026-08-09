import { Hono } from 'hono'
import type { Context } from 'hono'
import { authenticate } from '../middleware/api-key'
import { getStore } from '../db'
import { verifyProof } from '../lib/chain'
import { checkpointForChain, verifyMerkleProof } from '../services/anchor-batch'
import type { AppEnv } from '../index'
import { renderVerificationPage } from '../ui'

export const readRoutes = new Hono<AppEnv>()

readRoutes.get('/case/:ref/chain', async (c) => {
  const auth = await authenticate(c)
  if (auth instanceof Response) return auth
  const kind = c.req.query('kind') === 'machine' ? 'machine' : 'human'
  const chain = await getStore(c.env).getChain(auth.apiKey.tenantId, kind, c.req.param('ref'))
  if (!chain) return c.json({ error: 'not_found' }, 404)
  const events = await getStore(c.env).listChainEvents(chain.id)
  const checks = await Promise.all(events.map((event) => verifyProof({ chainId: event.chainId, position: event.chainPosition, receivedAt: event.receivedAt, payloadHash: event.payloadHash, previousProof: event.previousProof, proof: event.proof })))
  return c.json({ chain_id: chain.id, external_ref: chain.externalRef, kind: chain.kind, event_count: events.length, chain_integrity: checks.every(Boolean), events: events.map((event) => ({ proof: event.proof, previous_proof: event.previousProof, chain_position: event.chainPosition, received_at: event.receivedAt })) })
})

async function verification(c: Context<AppEnv>, proof: string) {
  const store = getStore(c.env)
  const event = await store.findEventByProof(proof)
  if (!event) return { status: 'not_found', verified: false, proof, chain_integrity: false, merkle_proof_valid: false, blockchain_anchor_valid: false, message: 'This proof does not exist.' }
  const events = await store.listChainEvents(event.chainId)
  const checks = await Promise.all(events.map((item) => verifyProof({ chainId: item.chainId, position: item.chainPosition, receivedAt: item.receivedAt, payloadHash: item.payloadHash, previousProof: item.previousProof, proof: item.proof })))
  const chainIntegrity = checks.every(Boolean)
  const checkpoint = await checkpointForChain(store, event.chainId)
  const anchor = await store.findAnchorByRoot(checkpoint.tree.root)
  const merkleProofValid = anchor ? await verifyMerkleProof(event.proof, checkpoint.tree.proofs[event.chainPosition - 1] ?? [], checkpoint.tree.root) : false
  const blockchainAnchorValid = anchor?.status === 'confirmed'
  const result = { status: blockchainAnchorValid ? 'confirmed' : 'pending_anchor', verified: chainIntegrity && merkleProofValid && blockchainAnchorValid, proof: event.proof, chain_integrity: chainIntegrity, merkle_proof_valid: merkleProofValid, blockchain_anchor_valid: blockchainAnchorValid, chain_position: event.chainPosition, received_at: event.receivedAt, network: c.env.NETWORK_NAME ?? 'polygon-amoy', message: chainIntegrity ? (anchor ? 'Record chain is intact; blockchain confirmation is pending.' : 'Record received by OD; waiting for an anchored checkpoint.') : 'Hash chain integrity failed.' }
  return result
}

readRoutes.get('/verify/public/:proof', async (c) => {
  const result = await verification(c, c.req.param('proof'))
  if (c.req.header('Accept')?.includes('text/html')) return c.html(renderVerificationPage(result))
  return c.json(result, result.status === 'not_found' ? 404 : 200)
})

readRoutes.get('/verify/:proof', async (c) => {
  const auth = await authenticate(c)
  if (auth instanceof Response) return auth
  const result = await verification(c, c.req.param('proof'))
  return c.json(result, result.status === 'not_found' ? 404 : 200)
})
