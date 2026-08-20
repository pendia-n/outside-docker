import { sha256Bytes } from './canonical'

export const MERKLE_ALGORITHM = 'OD1-MERKLE-SHA256-DUPLICATE-LAST' as const

export interface MerkleLeafInput {
  eventId: string
  proof: string
}

export interface MerkleProofStep {
  side: 'left' | 'right'
  hash: string
}

export interface MerkleLeaf {
  index: number
  value: MerkleLeafInput
  hash: string
  proof: MerkleProofStep[]
}

export interface MerkleTree {
  algorithm: typeof MERKLE_ALGORITHM
  root: string
  leaves: MerkleLeaf[]
  levels: string[][]
}

function assertDigest(hash: string, label: string): string {
  const normalized = hash.toLowerCase().replace(/^0x/, '')
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new TypeError(`${label} must be a SHA-256 hex digest`)
  return normalized
}

export async function merkleLeafHash(value: MerkleLeafInput): Promise<string> {
  if (!value.eventId) throw new TypeError('eventId is required for a Merkle leaf')
  return sha256Bytes(`OD1|MERKLE|${value.eventId}|${assertDigest(value.proof, 'event proof')}`)
}

export async function merkleNodeHash(left: string, right: string): Promise<string> {
  return sha256Bytes(`OD1|NODE|${assertDigest(left, 'left node')}|${assertDigest(right, 'right node')}`)
}

/**
 * Builds a deterministic binary tree. An odd node is paired with itself. This
 * policy is versioned in MERKLE_ALGORITHM and therefore portable in .odproof.
 */
export async function buildMerkleTree(values: readonly MerkleLeafInput[]): Promise<MerkleTree> {
  if (values.length === 0) throw new TypeError('A Merkle tree needs at least one leaf')

  const firstLevel = await Promise.all(values.map((value) => merkleLeafHash(value)))
  const levels: string[][] = [firstLevel]
  while (levels.at(-1)!.length > 1) {
    const current = levels.at(-1)!
    const next: string[] = []
    for (let index = 0; index < current.length; index += 2) {
      next.push(await merkleNodeHash(current[index], current[index + 1] ?? current[index]))
    }
    levels.push(next)
  }

  const leaves: MerkleLeaf[] = values.map((value, leafIndex) => {
    const proof: MerkleProofStep[] = []
    let index = leafIndex
    for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex += 1) {
      const level = levels[levelIndex]
      const isRight = index % 2 === 1
      const siblingIndex = isRight ? index - 1 : index + 1
      proof.push({
        side: isRight ? 'left' : 'right',
        hash: level[siblingIndex] ?? level[index],
      })
      index = Math.floor(index / 2)
    }
    return { index: leafIndex, value, hash: firstLevel[leafIndex], proof }
  })

  return { algorithm: MERKLE_ALGORITHM, root: levels.at(-1)![0], leaves, levels }
}

export async function verifyMerkleProof(value: MerkleLeafInput, proof: readonly MerkleProofStep[], expectedRoot: string): Promise<boolean> {
  if (proof.length > 52) throw new TypeError('Merkle proof is too deep')
  let current = await merkleLeafHash(value)
  for (const step of proof) {
    if (step.side !== 'left' && step.side !== 'right') throw new TypeError('Merkle proof side must be left or right')
    const sibling = assertDigest(step.hash, 'proof sibling')
    current = step.side === 'left'
      ? await merkleNodeHash(sibling, current)
      : await merkleNodeHash(current, sibling)
  }
  return current === assertDigest(expectedRoot, 'expected root')
}

/** Derives the zero-based leaf index encoded by the ordered proof directions. */
export function merkleProofLeafIndex(proof: readonly MerkleProofStep[]): number {
  if (proof.length > 52) throw new TypeError('Merkle proof is too deep')
  let index = 0
  let weight = 1
  for (const step of proof) {
    if (step.side !== 'left' && step.side !== 'right') throw new TypeError('Merkle proof side must be left or right')
    if (step.side === 'left') index += weight
    weight *= 2
  }
  return index
}

export function toBytes32(hash: string): `0x${string}` {
  return `0x${assertDigest(hash, 'hash')}`
}
