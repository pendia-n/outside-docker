import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMerkleTree, merkleProofLeafIndex, verifyMerkleProof } from './merkle'

test('Merkle roots and proofs are deterministic, including odd leaf counts', async () => {
  const values = [
    { eventId: 'a', proof: 'a'.repeat(64) },
    { eventId: 'b', proof: 'b'.repeat(64) },
    { eventId: 'c', proof: 'c'.repeat(64) },
  ]
  const first = await buildMerkleTree(values)
  const second = await buildMerkleTree(values)
  assert.equal(first.root, second.root)
  assert.equal(first.leaves.length, 3)
  for (const leaf of first.leaves) {
    assert.equal(await verifyMerkleProof(leaf.value, leaf.proof, first.root), true)
    assert.equal(merkleProofLeafIndex(leaf.proof), leaf.index)
  }
})

test('Merkle verification fails for a changed leaf or root', async () => {
  const one = { eventId: 'one', proof: '1'.repeat(64) }
  const tree = await buildMerkleTree([one, { eventId: 'two', proof: '2'.repeat(64) }])
  assert.equal(await verifyMerkleProof({ ...one, eventId: 'changed' }, tree.leaves[0].proof, tree.root), false)
  assert.equal(await verifyMerkleProof(one, tree.leaves[0].proof, '0'.repeat(64)), false)
})
