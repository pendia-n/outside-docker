import fs from 'node:fs'
import path from 'node:path'
import solc from 'solc'
import { ethers } from 'ethers'

const root = path.resolve(new URL('.', import.meta.url).pathname, '..')
const envPath = path.resolve(root, '..', '.env')
const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => {
  const i = line.indexOf('=')
  return [line.slice(0, i), line.slice(i + 1)]
}))
if (!env.POLYGON_RPC_URL || !env.POLYGON_PRIVATE_KEY) throw new Error('POLYGON_RPC_URL and POLYGON_PRIVATE_KEY are required')
const source = fs.readFileSync(path.resolve(root, 'contracts/src/ODAnchor.sol'), 'utf8')
const input = {
  language: 'Solidity',
  sources: { 'ODAnchor.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
if (output.errors?.some((e) => e.severity === 'error')) throw new Error(output.errors.filter((e) => e.severity === 'error').map((e) => e.formattedMessage).join('\n'))
const artifact = output.contracts['ODAnchor.sol'].ODAnchor
const provider = new ethers.JsonRpcProvider(env.POLYGON_RPC_URL, 80002)
const wallet = new ethers.Wallet(env.POLYGON_PRIVATE_KEY, provider)
const network = await provider.getNetwork()
if (network.chainId !== 80002n) throw new Error(`Refusing deployment: RPC chain is ${network.chainId}, expected Amoy 80002`)
const balance = await provider.getBalance(wallet.address)
if (balance === 0n) throw new Error(`Deployer has zero Amoy balance: ${wallet.address}`)
const factory = new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, wallet)
const contract = await factory.deploy(wallet.address)
const deployment = await contract.deploymentTransaction().wait()
const address = await contract.getAddress()
fs.writeFileSync(path.resolve(root, 'contracts/ODAnchor.amoy.json'), JSON.stringify({ address, deployer: wallet.address, chainId: 80002, deploymentTx: deployment.hash, abi: artifact.abi }, null, 2) + '\n')
console.log(JSON.stringify({ address, deployer: wallet.address, chainId: 80002, deploymentTx: deployment.hash }))
