import { describe, expect, it } from 'vitest'
import { buildMerkleTree, verifyMerkleProof } from '../src/lib/merkle'

describe('Merkle tree', () => {
  it.each([1, 2, 3, 7])('builds and verifies a tree with %i leaves', async (count) => {
    const leaves = Array.from({ length: count }, (_, index) => `proof-${index}`)
    const tree = await buildMerkleTree(leaves)
    expect(tree.root).toMatch(/^[0-9a-f]{64}$/)
    for (const [index, leaf] of leaves.entries()) {
      const proof = tree.proofs[index]
      expect(proof).toBeDefined()
      await expect(verifyMerkleProof(leaf, proof!, tree.root)).resolves.toBe(true)
    }
  })

  it('rejects a wrong leaf, root, or sibling orientation', async () => {
    const tree = await buildMerkleTree(['a', 'b', 'c'])
    const proof = tree.proofs[0]!
    await expect(verifyMerkleProof('x', proof, tree.root)).resolves.toBe(false)
    await expect(verifyMerkleProof('a', proof, '0'.repeat(64))).resolves.toBe(false)
  })
})
