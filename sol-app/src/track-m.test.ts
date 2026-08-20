import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainError } from './chain-do'
import { deriveMachineCommitment, machineManifestHash, machineRequestHash } from './track-m'

const salt = '1'.repeat(64)

test('equivalent JSON produces the same machine commitment', async () => {
  const first = await deriveMachineCommitment({ json: { z: 2, a: 1 }, record_salt: salt })
  const second = await deriveMachineCommitment({ json: { a: 1, z: 2 }, record_salt: salt })
  assert.equal(first, second)
  assert.equal(first.length, 64)
})

test('machine request and manifest hashing are deterministic', async () => {
  const input = {
    source_id: 'drone-07',
    delivery_id: 'DEL-1',
    action: 'PICKUP_CONFIRMED',
    occurred_at: '2026-01-02T03:04:05Z',
    sequence: 14,
    commitment: 'a'.repeat(64),
  }
  assert.equal(await machineRequestHash(input), await machineRequestHash({ ...input }))
  assert.equal(await machineManifestHash(input, input.commitment), await machineManifestHash({ ...input }, input.commitment))
})

test('server refuses paths and remote URLs', async () => {
  await assert.rejects(() => machineRequestHash({
    source_id: 's', action: 'A', occurred_at: '2026-01-01T00:00:00Z', commitment: 'a'.repeat(64),
    metadata: { url: 'https://example.invalid/file' },
  }), (error: unknown) => {
    assert.ok(error instanceof DomainError)
    assert.equal(error.code, 'unsupported_input')
    return true
  })
})
