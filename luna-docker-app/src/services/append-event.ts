import { canonicalBytes } from '../lib/canonical'
import { computeProof } from '../lib/chain'
import { deriveChainKey, encryptJson, generateSalt } from '../lib/crypto'
import type { Kind, Store, EventRecord } from '../db'

export type AppendInput = {
  tenantId: string
  kind: Kind
  externalRef: string
  chainSecret: string
  idempotencyKey: string
  payload: Record<string, unknown>
}

const locks = new Map<string, Promise<void>>()

async function withChainLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, previous.then(() => current))
  await previous
  try { return await operation() } finally { release(); if (locks.get(key) === current) locks.delete(key) }
}

export async function appendEvent(store: Store, input: AppendInput): Promise<{ event: EventRecord; replayed: boolean }> {
  const lockKey = `${input.tenantId}:${input.kind}:${input.externalRef}`
  return withChainLock(lockKey, async () => {
    const existing = await store.findEventByIdempotency(input.tenantId, input.idempotencyKey)
    if (existing) return { event: existing, replayed: true }
    if (input.chainSecret.length < 16) throw new Error('chain_secret must contain at least 16 characters')
    let chain = await store.getChain(input.tenantId, input.kind, input.externalRef)
    if (!chain) {
      chain = { id: crypto.randomUUID(), tenantId: input.tenantId, kind: input.kind, externalRef: input.externalRef, chainSalt: generateSalt(), headProof: null, eventCount: 0 }
      await store.createChain(chain)
    }
    const latest = await store.getLatestEvent(chain.id)
    const position = (latest?.chainPosition ?? 0) + 1
    const receivedAt = new Date().toISOString()
    const payload = { ...input.payload, event_nonce: crypto.randomUUID() }
    const payloadHash = await (await import('../lib/crypto')).sha256Hex(canonicalBytes(payload))
    const key = await deriveChainKey(input.chainSecret, chain.chainSalt)
    const encrypted = await encryptJson(key, { payload, payload_hash: payloadHash }, `${input.tenantId}/${chain.id}/${position}`)
    const proof = await computeProof({ chainId: chain.id, position, receivedAt, payloadHash, previousProof: latest?.proof ?? null })
    const event: EventRecord = { id: crypto.randomUUID(), tenantId: input.tenantId, chainId: chain.id, kind: input.kind, idempotencyKey: input.idempotencyKey, ciphertext: encrypted.ciphertext, encryptionNonce: encrypted.nonce, payloadHash, proof, previousProof: latest?.proof ?? null, chainPosition: position, receivedAt, createdAt: receivedAt }
    await store.insertEvent(event)
    await store.updateChain(chain.id, proof, position)
    return { event, replayed: false }
  })
}
