import { frame } from './bytes'
import { sha256Hex } from './crypto'

export type ProofInput = {
  chainId: string
  position: number
  receivedAt: string
  payloadHash: string
  previousProof: string | null
}

export async function computeProof(input: ProofInput): Promise<string> {
  return sha256Hex(frame([
    'outside-docker/event/v1',
    input.chainId,
    String(input.position),
    input.receivedAt,
    input.payloadHash,
    input.previousProof ?? 'GENESIS',
  ]))
}

export async function verifyProof(input: ProofInput & { proof: string }): Promise<boolean> {
  return (await computeProof(input)) === input.proof
}
