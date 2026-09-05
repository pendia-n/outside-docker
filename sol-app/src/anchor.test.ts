import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAnchorMaterial, PolygonAnchorService } from './anchor'
import { verifyMerkleProof } from './merkle'

test('anchor material binds ordered event ids and proofs', async () => {
  const events = [
    { id: 'event-1', proof: '1'.repeat(64), received_at: '2026-01-01T00:00:00Z' },
    { id: 'event-2', proof: '2'.repeat(64), received_at: '2026-01-01T00:00:01Z' },
    { id: 'event-3', proof: '3'.repeat(64), received_at: '2026-01-01T00:00:02Z' },
  ]
  const material = await buildAnchorMaterial(events)
  assert.equal(material.leaves.length, 3)
  assert.equal(await verifyMerkleProof(
    { eventId: material.leaves[2].eventId, proof: material.leaves[2].eventProof },
    material.leaves[2].proof,
    material.merkleRoot,
  ), true)
})

test('changing an event id changes the anchor root', async () => {
  const first = await buildAnchorMaterial([{ id: 'event-a', proof: 'a'.repeat(64), received_at: 'x' }])
  const second = await buildAnchorMaterial([{ id: 'event-b', proof: 'a'.repeat(64), received_at: 'x' }])
  assert.notEqual(first.merkleRoot, second.merkleRoot)
})

test('prepared batch binds manifest, counts, and chain configuration in column order', async () => {
  class Statement {
    readonly sql: string
    values: unknown[] = []

    constructor(sql: string) { this.sql = sql }
    bind(...values: unknown[]) { this.values = values; return this }
    async all<T>() {
      const results = this.sql.includes("anchor_status = 'pending_anchor'")
        ? [{ id: 'event-1', proof: 'a'.repeat(64), received_at: '2026-01-01T00:00:00.000Z' }]
        : []
      return { results: results as T[], success: true, meta: {} }
    }
  }

  const statements: Statement[] = []
  let batched: Statement[] = []
  const database = {
    prepare(sql: string) { const statement = new Statement(sql); statements.push(statement); return statement },
    async batch(input: Statement[]) { batched = input; return [] },
  } as unknown as D1Database
  const service = new PolygonAnchorService(database, {
    async anchorBatch() { throw new Error('not used') },
  }, {
    environment: 'prod',
    chainId: '137',
    network: 'polygon',
    contractAddress: '0x1111111111111111111111111111111111111111',
  }, () => new Date('2026-01-01T00:01:00.000Z'))

  const prepared = await service.prepareBatch()
  assert.ok(prepared)
  const insert = batched.find((statement) => statement.sql.includes('INSERT INTO anchor_batches'))
  assert.ok(insert)
  assert.equal(insert.values.length, 12)
  assert.deepEqual(insert.values.slice(1), [
    'prod',
    prepared.batch_ref,
    prepared.merkle_root,
    prepared.manifest_hash,
    1,
    1,
    '137',
    'polygon',
    '0x1111111111111111111111111111111111111111',
    '2026-01-01T00:01:00.000Z',
    '2026-01-01T00:01:00.000Z',
  ])
  assert.ok(statements.length >= 1)
})

test('stale submitted batches finalize from the recorded chain transaction without rebroadcasting', async () => {
  class Statement {
    values: unknown[] = []
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) { this.values = values; return this }
    async all<T>() {
      return {
        results: [{
          id: 'batch-1',
          batch_ref: 'a'.repeat(64),
          status: 'submitted',
          merkle_root: 'b'.repeat(64),
          manifest_hash: 'c'.repeat(64),
          leaf_count: 1,
          event_count: 1,
          attempt_count: 1,
          next_retry_at: null,
          tx_hash: `0x${'d'.repeat(64)}`,
          submitted_at: '2026-01-01T00:00:00.000Z',
        }] as T[],
        success: true,
        meta: {},
      }
    }
  }
  let batched: Statement[] = []
  const database = {
    prepare(sql: string) { return new Statement(sql) },
    async batch(input: Statement[]) { batched = input; return [] },
  } as unknown as D1Database
  let broadcasts = 0
  const service = new PolygonAnchorService(database, {
    async anchorBatch() { broadcasts += 1; throw new Error('must not rebroadcast') },
    async transactionStatus() {
      return {
        state: 'confirmed',
        receipt: { status: 1, blockNumber: 42, blockHash: `0x${'e'.repeat(64)}` },
      }
    },
  }, {
    environment: 'dev',
    chainId: '80002',
    network: 'polygon-amoy',
    contractAddress: '0x1111111111111111111111111111111111111111',
  }, () => new Date('2026-01-01T01:00:00.000Z'))

  assert.equal(await service.recoverStaleSubmitted(), 1)
  assert.equal(broadcasts, 0)
  assert.equal(batched.length, 5)
  assert.match(batched[0].sql, /status = 'confirmed'/)
  assert.match(batched[2].sql, /anchor_status = 'anchored'/)
})

test('stale submitted batches with a dropped transaction return to bounded retry', async () => {
  class Statement {
    values: unknown[] = []
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) { this.values = values; return this }
    async all<T>() {
      return {
        results: [{
          id: 'batch-2',
          batch_ref: 'a'.repeat(64),
          status: 'submitted',
          merkle_root: 'b'.repeat(64),
          manifest_hash: 'c'.repeat(64),
          leaf_count: 1,
          event_count: 1,
          attempt_count: 1,
          next_retry_at: null,
          tx_hash: `0x${'d'.repeat(64)}`,
          submitted_at: '2026-01-01T00:00:00.000Z',
        }] as T[],
        success: true,
        meta: {},
      }
    }
  }
  let batched: Statement[] = []
  const database = {
    prepare(sql: string) { return new Statement(sql) },
    async batch(input: Statement[]) { batched = input; return [] },
  } as unknown as D1Database
  const service = new PolygonAnchorService(database, {
    async anchorBatch() { throw new Error('not used') },
    async transactionStatus() { return { state: 'missing' } },
  }, {
    environment: 'dev',
    chainId: '80002',
    network: 'polygon-amoy',
    contractAddress: '0x1111111111111111111111111111111111111111',
  }, () => new Date('2026-01-01T01:00:00.000Z'))

  assert.equal(await service.recoverStaleSubmitted(), 1)
  assert.equal(batched.length, 2)
  assert.equal(batched[0].values[0], 'retry')
  assert.match(String(batched[0].values[2]), /no longer available/)
})
