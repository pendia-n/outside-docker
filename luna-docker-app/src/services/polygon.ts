import { createPublicClient, createWalletClient, http, keccak256, stringToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygonAmoy } from 'viem/chains'
import type { AnchorRecord } from '../db'
import type { Bindings } from '../index'

const abi = [{ type: 'function', name: 'anchor', stateMutability: 'nonpayable', inputs: [{ name: 'batchId', type: 'bytes32' }, { name: 'merkleRoot', type: 'bytes32' }, { name: 'leafCount', type: 'uint256' }], outputs: [] }] as const

export async function submitPolygonAmoyAnchor(env: Bindings, anchor: AnchorRecord): Promise<{ txHash: `0x${string}`; blockNumber: number }> {
  if (!env.POLYGON_RPC_URL || !env.POLYGON_PRIVATE_KEY || !env.POLYGON_CONTRACT_ADDRESS) throw new Error('Polygon Amoy secrets are not configured')
  const account = privateKeyToAccount(env.POLYGON_PRIVATE_KEY as `0x${string}`)
  const address = env.POLYGON_CONTRACT_ADDRESS as `0x${string}`
  const wallet = createWalletClient({ account, chain: polygonAmoy, transport: http(env.POLYGON_RPC_URL) })
  const publicClient = createPublicClient({ chain: polygonAmoy, transport: http(env.POLYGON_RPC_URL) })
  const batchId = keccak256(stringToBytes(`outside-docker/batch/v1/${anchor.merkleRoot}`))
  const txHash = await wallet.writeContract({ address, abi, functionName: 'anchor', args: [batchId, `0x${anchor.merkleRoot}`, BigInt(anchor.leafCount)] })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error('Polygon transaction reverted')
  return { txHash, blockNumber: Number(receipt.blockNumber) }
}
