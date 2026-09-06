import fs from 'node:fs'
import path from 'node:path'
import { ethers } from 'ethers'

const root = path.resolve(new URL('.', import.meta.url).pathname, '..')
const artifact = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'OutDock.base-build.json'), 'utf8'))
const rpcUrl = process.env.BASE_RPC_URL
const privateKey = process.env.BASE_PRIVATE_KEY
if (!rpcUrl || !privateKey) throw new Error('BASE_RPC_URL and BASE_PRIVATE_KEY are required')

const provider = new ethers.JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true })
const wallet = new ethers.Wallet(privateKey, provider)
const network = await provider.getNetwork()
if (network.chainId !== 8453n) throw new Error(`Refusing deployment: RPC chain is ${network.chainId}, expected Base mainnet 8453`)

const owner = ethers.getAddress(process.env.OUTDOCK_OWNER_ADDRESS || wallet.address)
const anchorer = ethers.getAddress(process.env.OUTDOCK_ANCHORER_ADDRESS || wallet.address)
const balance = await provider.getBalance(wallet.address)
const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet)
const deploymentRequest = await factory.getDeployTransaction(owner, anchorer)
const estimatedGas = await provider.estimateGas({ ...deploymentRequest, from: wallet.address })
const feeData = await provider.getFeeData()
const estimatedCost = estimatedGas * (feeData.maxFeePerGas || feeData.gasPrice || 0n)
if (balance < estimatedCost) {
  throw new Error(`Insufficient Base ETH: balance ${ethers.formatEther(balance)}, estimated maximum ${ethers.formatEther(estimatedCost)}`)
}

console.log(JSON.stringify({
  stage: 'preflight',
  chainId: Number(network.chainId),
  deployer: wallet.address,
  owner,
  anchorer,
  balanceEth: ethers.formatEther(balance),
  estimatedGas: estimatedGas.toString(),
  estimatedMaximumCostEth: ethers.formatEther(estimatedCost),
}))
if (process.env.OUTDOCK_DRY_RUN === '1') process.exit(0)

const contract = await factory.deploy(owner, anchorer)
const transaction = contract.deploymentTransaction()
if (!transaction) throw new Error('Deployment transaction was not created')
console.log(JSON.stringify({ stage: 'submitted', transactionHash: transaction.hash }))
const receipt = await transaction.wait(3)
if (!receipt || receipt.status !== 1) throw new Error('OutDock deployment transaction failed')

const address = await contract.getAddress()
const deployedCode = await provider.getCode(address)
if (deployedCode.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) {
  throw new Error('Deployed runtime bytecode does not match the compiled artifact')
}
const deployment = {
  contractName: 'OutDock',
  address,
  deployer: wallet.address,
  owner,
  anchorer,
  chainId: 8453,
  network: 'base',
  deploymentTx: transaction.hash,
  blockNumber: receipt.blockNumber,
  compilerVersion: artifact.compilerVersion,
  optimizer: { enabled: true, runs: 200 },
  constructorArguments: [owner, anchorer],
  abi: artifact.abi,
}
fs.writeFileSync(path.join(root, 'contracts', 'OutDock.base-mainnet.json'), `${JSON.stringify(deployment, null, 2)}\n`)
console.log(JSON.stringify({ stage: 'confirmed', ...deployment, abi: undefined }))
