import { describe, expect, it } from 'vitest'
import { computeProof, verifyProof } from '../src/lib/chain'

describe('hash chain proofs', () => {
  const base = { chainId: 'chain-1', position: 1, receivedAt: '2026-01-01T00:00:00.000Z', payloadHash: 'a'.repeat(64), previousProof: null }

  it('creates and verifies a genesis proof', async () => {
    const proof = await computeProof(base)
    await expect(verifyProof({ ...base, proof })).resolves.toBe(true)
  })

  it('links a subsequent proof to its predecessor', async () => {
    const first = await computeProof(base)
    const secondInput = { ...base, position: 2, payloadHash: 'b'.repeat(64), previousProof: first }
    const second = await computeProof(secondInput)
    await expect(verifyProof({ ...secondInput, proof: second })).resolves.toBe(true)
    await expect(verifyProof({ ...secondInput, proof: first })).resolves.toBe(false)
  })

  it('detects mutation, deletion, and reorder', async () => {
    const first = await computeProof(base)
    const secondInput = { ...base, position: 2, payloadHash: 'b'.repeat(64), previousProof: first }
    const second = await computeProof(secondInput)
    await expect(verifyProof({ ...secondInput, payloadHash: 'c'.repeat(64), proof: second })).resolves.toBe(false)
    await expect(verifyProof({ ...secondInput, position: 3, proof: second })).resolves.toBe(false)
    await expect(verifyProof({ ...secondInput, previousProof: null, proof: second })).resolves.toBe(false)
  })
})
