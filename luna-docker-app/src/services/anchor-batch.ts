import { buildMerkleTree, verifyMerkleProof } from '../lib/merkle'
import { sha256Hex } from '../lib/crypto'
import { canonicalBytes } from '../lib/canonical'
import type { AnchorRecord, Store } from '../db'

export async function checkpointForChain(store: Store, chainId: string) {
  const events = await store.listChainEvents(chainId)
  if (events.length === 0) throw new Error('cannot anchor an empty chain')
  const tree = await buildMerkleTree(events.map((event) => event.proof))
  return { events, tree }
}

export async function createLocalAnchor(store: Store, chainId: string, network = 'polygon-amoy', networkChainId = 80002): Promise<AnchorRecord> {
  const { events, tree } = await checkpointForChain(store, chainId)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const anchor: AnchorRecord = { id, merkleRoot: tree.root, leafCount: events.length, network, networkChainId, txHash: null, blockNumber: null, status: 'pending', submittedAt: now, confirmedAt: null, createdAt: now }
  await store.saveAnchor(anchor)
  return anchor
}

export async function createCheckpointLeaf(chainId: string, headProof: string, eventCount: number): Promise<string> {
  return sha256Hex(canonicalBytes({ domain: 'outside-docker/checkpoint/v1', chain_id: chainId, head_proof: headProof, event_count: eventCount }))
}

export { verifyMerkleProof }
