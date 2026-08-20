import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DomainError,
  D1ChainRepository,
  SerializedChainService,
  computeEventProof,
  logicalChainName,
  type ChainRepository,
  type IdempotencyRow,
  type PersistedAppend,
} from './chain-do'

class MemoryRepository implements ChainRepository {
  idempotency = new Map<string, IdempotencyRow>()
  chain: { id: string; previous_proof: string | null; next_position: number } | null = null

  async findIdempotency(type: 'session' | 'api_key', id: string, key: string) {
    return this.idempotency.get(`${type}:${id}:${key}`) ?? null
  }
  async findChain() { return this.chain }
  async findCorrectionTarget() { return null }
  async findSource() { return null }
  async commitAppend(append: PersistedAppend) {
    this.chain = { id: append.chain.id, previous_proof: append.proof, next_position: append.position + 1 }
    this.idempotency.set(
      `${append.input.credentialType}:${append.input.credentialId}:${append.input.idempotencyKey}`,
      { request_hash: append.input.requestHash, response_json: JSON.stringify(append.result), status: 'completed' },
    )
  }
}

const digest = 'a'.repeat(64)
const base = {
  ownerId: 'owner-1',
  track: 'H' as const,
  externalRef: 'CASE-1',
  eventType: 'CAPTURED',
  commitment: digest,
  manifestHash: 'b'.repeat(64),
  credentialType: 'session' as const,
  credentialId: 'session-1',
  idempotencyKey: 'request-0001',
  requestHash: 'c'.repeat(64),
}

test('event proof binds the chain id', async () => {
  const common = { position: 1, receivedAt: '2026-01-01T00:00:00.000Z', commitment: digest, previousProof: null }
  assert.notEqual(
    await computeEventProof({ ...common, chainId: 'chain-a' }),
    await computeEventProof({ ...common, chainId: 'chain-b' }),
  )
})

test('serialized append signs the receipt and replays an identical idempotent result', async () => {
  const repository = new MemoryRepository()
  const service = new SerializedChainService(repository, {
    keyId: 'test-key',
    algorithm: 'Ed25519',
    async sign(message) { return `signed-${message.byteLength}` },
  }, () => new Date('2026-01-01T00:00:00.000Z'))
  const created = await service.append(base)
  const replayed = await service.append(base)
  assert.deepEqual(replayed, created)
  assert.equal(created.receipt.chain_id, created.chain_id)
  assert.equal(created.signed_receipt.receipt.event_id, created.event_id)
  assert.match(created.signature, /^signed-/)
})

test('same idempotency key with a different body hash conflicts', async () => {
  const repository = new MemoryRepository()
  const service = new SerializedChainService(repository, { keyId: 'key', algorithm: 'Ed25519', async sign() { return 's' } })
  await service.append(base)
  await assert.rejects(() => service.append({ ...base, requestHash: 'd'.repeat(64) }), (error: unknown) => {
    assert.ok(error instanceof DomainError)
    assert.equal(error.status, 409)
    return true
  })
})

test('a cross-chain D1 idempotency race returns the committed winner', async () => {
  class RacingRepository extends MemoryRepository {
    async commitAppend(append: PersistedAppend) {
      this.idempotency.set(
        `${append.input.credentialType}:${append.input.credentialId}:${append.input.idempotencyKey}`,
        { request_hash: append.input.requestHash, response_json: JSON.stringify(append.result), status: 'completed' },
      )
      throw new Error('UNIQUE constraint failed: idempotency_records')
    }
  }
  const repository = new RacingRepository()
  const service = new SerializedChainService(repository, {
    keyId: 'test-key', algorithm: 'Ed25519', async sign() { return 'winner-signature' },
  }, () => new Date('2026-01-01T00:00:00.000Z'))
  const result = await service.append(base)
  assert.equal(result.signature, 'winner-signature')
  assert.equal(result.receipt.chain_id, result.chain_id)
})

test('logical chain identity includes owner, track, and external reference', () => {
  assert.notEqual(logicalChainName('a', 'H', 'same'), logicalChainName('b', 'H', 'same'))
  assert.notEqual(logicalChainName('a', 'H', 'same'), logicalChainName('a', 'M', 'same'))
})

test('D1 append persists owner-bound idempotency in the same atomic batch', async () => {
  const captured: Array<{ sql: string; values: unknown[] }> = []
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          assert.equal((sql.match(/\?/g) ?? []).length, values.length, `placeholder mismatch in ${sql}`)
          const statement = { sql, values }
          captured.push(statement)
          return statement
        },
      }
    },
    async batch() { return [] },
  } as unknown as D1Database
  const repository = new D1ChainRepository(database)
  const receipt = {
    version: 'OD-RECEIPT-1' as const,
    environment: 'dev' as const,
    event_id: 'event-1', chain_id: 'chain-1', external_ref: 'CASE-1', track: 'H' as const,
    event_type: 'CAPTURED', position: 1, commitment: 'a'.repeat(64), manifest_hash: 'b'.repeat(64),
    proof: 'c'.repeat(64), previous_proof: null, occurred_at: null,
    received_at: '2026-01-01T00:00:00.000Z', delivery_id: null, sequence: null,
    sequence_status: null, anchor_status: 'pending_anchor' as const, signing_key_id: 'key-1', signature_algorithm: 'Ed25519' as const,
  }
  await repository.commitAppend({
    input: { ...base, occurredAt: null },
    chain: { id: 'chain-1', previous_proof: null, next_position: 1 },
    isNewChain: true,
    eventId: 'event-1', receivedAt: receipt.received_at, previousProof: null, position: 1,
    proof: receipt.proof, sequenceStatus: null, metadataJson: null, receiptPayloadHash: 'd'.repeat(64),
    result: {
      event_id: 'event-1', chain_id: 'chain-1', position: 1, proof: receipt.proof,
      previous_proof: null, anchor_status: 'pending_anchor', receipt,
      receipt_json: JSON.stringify(receipt), signature: 'sig', signing_key_id: 'key-1', signature_algorithm: 'Ed25519',
      signed_receipt: { receipt, receipt_json: JSON.stringify(receipt), signature: 'sig', signing_key_id: 'key-1', signature_algorithm: 'Ed25519' },
    },
  })
  const idempotency = captured.find((entry) => /INSERT INTO idempotency_records/.test(entry.sql))
  assert.ok(idempotency)
  assert.match(idempotency.sql, /id, owner_id, credential_type/)
  assert.equal(idempotency.values[1], 'owner-1')
})
