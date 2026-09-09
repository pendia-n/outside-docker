import fs from 'node:fs'
import path from 'node:path'
import { ethers } from 'ethers'

const root = path.resolve(new URL('.', import.meta.url).pathname, '..')
const artifact = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'OutDock.base-build.json'), 'utf8'))
const localEnvPath = path.resolve(root, '..', '.env')
if (fs.existsSync(localEnvPath)) {
  for (const line of fs.readFileSync(localEnvPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    const key = line.slice(0, index).trim()
    if (process.env[key] === undefined) process.env[key] = line.slice(index + 1).trim()
  }
}
const rpcUrl = process.env.POLYGON_RPC_URL
const privateKey = process.env.POLYGON_PRIVATE_KEY
if (!rpcUrl || !privateKey) throw new Error('POLYGON_RPC_URL and POLYGON_PRIVATE_KEY are required')

const provider = new ethers.JsonRpcProvider(rpcUrl, 80002, { staticNetwork: true })
const wallet = new ethers.Wallet(privateKey, provider)
if ((await provider.getNetwork()).chainId !== 80002n) throw new Error('Refusing deployment: expected Polygon Amoy chain 80002')
const owner = ethers.getAddress(process.env.POLYGON_OWNER_ADDRESS || wallet.address)
const anchorer = ethers.getAddress(process.env.POLYGON_ANCHORER_ADDRESS || wallet.address)
const balance = await provider.getBalance(wallet.address)
const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet)
const tx = await factory.deploy(owner, anchorer)
const deploymentTx = tx.deploymentTransaction()
if (!deploymentTx) throw new Error('Deployment transaction was not created')
console.log(JSON.stringify({ stage: 'submitted', chainId: 80002, deployer: wallet.address, transactionHash: deploymentTx.hash, balanceEth: ethers.formatEther(balance) }))
const receipt = await deploymentTx.wait(3)
if (!receipt || receipt.status !== 1) throw new Error('OutDock Amoy deployment failed')
const address = await tx.getAddress()
if ((await provider.getCode(address)).toLowerCase() !== artifact.deployedBytecode.toLowerCase()) throw new Error('Amoy runtime bytecode mismatch')
const record = { contractName: 'OutDock', address, deployer: wallet.address, owner, anchorer, chainId: 80002, network: 'polygon-amoy', deploymentTx: deploymentTx.hash, blockNumber: receipt.blockNumber, compilerVersion: artifact.compilerVersion, optimizer: { enabled: true, runs: 200 }, constructorArguments: [owner, anchorer], abi: artifact.abi }
fs.writeFileSync(path.join(root, 'contracts', 'OutDock.polygon-amoy.json'), `${JSON.stringify(record, null, 2)}\n`)
console.log(JSON.stringify({ stage: 'confirmed', ...record, abi: undefined }))
