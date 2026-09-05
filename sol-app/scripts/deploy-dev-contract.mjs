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
if (!env.BASE_RPC_URL || !env.BASE_PRIVATE_KEY) throw new Error('BASE_RPC_URL and BASE_PRIVATE_KEY are required')
const source = fs.readFileSync(path.resolve(root, 'contracts/src/ODAnchor.sol'), 'utf8')
const input = {
  language: 'Solidity',
  sources: { 'ODAnchor.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
if (output.errors?.some((e) => e.severity === 'error')) throw new Error(output.errors.filter((e) => e.severity === 'error').map((e) => e.formattedMessage).join('\n'))
const artifact = output.contracts['ODAnchor.sol'].ODAnchor
const provider = new ethers.JsonRpcProvider(env.BASE_RPC_URL, 84532)
const wallet = new ethers.Wallet(env.BASE_PRIVATE_KEY, provider)
const network = await provider.getNetwork()
if (network.chainId !== 84532n) throw new Error(`Refusing deployment: RPC chain is ${network.chainId}, expected Base Sepolia 84532`)
const balance = await provider.getBalance(wallet.address)
if (balance === 0n) throw new Error(`Deployer has zero Base Sepolia ETH balance: ${wallet.address}`)
const factory = new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, wallet)
const contract = await factory.deploy(wallet.address)
const deployment = await contract.deploymentTransaction().wait()
const address = await contract.getAddress()
fs.writeFileSync(path.resolve(root, 'contracts/ODAnchor.base-sepolia.json'), JSON.stringify({ address, deployer: wallet.address, chainId: 84532, deploymentTx: deployment.hash, abi: artifact.abi }, null, 2) + '\n')
console.log(JSON.stringify({ address, deployer: wallet.address, chainId: 84532, deploymentTx: deployment.hash }))
