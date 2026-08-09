import { frame } from './bytes'
import { sha256Hex } from './crypto'

export type MerkleSibling = { hash: string; position: 'left' | 'right' }
export type MerkleProof = MerkleSibling[]
export type MerkleTree = { root: string; leaves: string[]; proofs: MerkleProof[] }

async function leafHash(leaf: string): Promise<string> {
  return sha256Hex(frame(['outside-docker/merkle-leaf/v1', leaf]))
}

async function nodeHash(left: string, right: string): Promise<string> {
  return sha256Hex(frame(['outside-docker/merkle-node/v1', left, right]))
}

export async function buildMerkleTree(leaves: readonly string[]): Promise<MerkleTree> {
  if (leaves.length === 0) throw new Error('cannot build an empty Merkle tree')
  const proofs: MerkleProof[] = leaves.map(() => [])
  let level = await Promise.all(leaves.map(leafHash))
  let groups = leaves.map((_, index) => [index])
  while (level.length > 1) {
    const next: string[] = []
    const nextGroups: number[][] = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index] as string
      const right = level[index + 1] ?? left
      const leftGroup = groups[index] as number[]
      const rightGroup = groups[index + 1] ?? leftGroup
      for (const original of leftGroup) proofs[original]!.push({ hash: right, position: 'right' })
      if (groups[index + 1] !== undefined) {
        for (const original of rightGroup) proofs[original]!.push({ hash: left, position: 'left' })
      }
      next.push(await nodeHash(left, right))
      nextGroups.push(groups[index + 1] !== undefined ? [...leftGroup, ...rightGroup] : [...leftGroup])
    }
    level = next
    groups = nextGroups
  }
  return { root: level[0] as string, leaves: [...leaves], proofs }
}

export async function verifyMerkleProof(leaf: string, proof: MerkleProof, root: string): Promise<boolean> {
  let current = await leafHash(leaf)
  for (const sibling of proof) {
    current = sibling.position === 'left'
      ? await nodeHash(sibling.hash, current)
      : await nodeHash(current, sibling.hash)
  }
  return current === root
}
