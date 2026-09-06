import fs from 'node:fs'
import path from 'node:path'
import solc from 'solc'
import { ethers } from 'ethers'

const root = path.resolve(new URL('.', import.meta.url).pathname, '..')
const apiKey = process.env.ETHERSCAN_API_KEY
if (!apiKey) throw new Error('ETHERSCAN_API_KEY is required')
const deployment = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'OutDock.base-mainnet.json'), 'utf8'))
const sourceName = 'OutDock.sol'
const source = fs.readFileSync(path.join(root, 'contracts', 'src', sourceName), 'utf8')
const standardInput = {
  language: 'Solidity',
  sources: { [sourceName]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
}
const compilerVersion = `v${solc.version().replace(/\.Emscripten\.clang$/u, '')}`
const constructorArguments = ethers.AbiCoder.defaultAbiCoder()
  .encode(['address', 'address'], deployment.constructorArguments)
  .slice(2)

async function etherscan(parameters) {
  const query = new URLSearchParams({ chainid: '8453', apikey: apiKey })
  const body = new URLSearchParams(parameters)
  const response = await fetch(`https://api.etherscan.io/v2/api?${query}`, { method: 'POST', body })
  if (!response.ok) throw new Error(`Etherscan HTTP ${response.status}`)
  return response.json()
}

const submitted = await etherscan({
  module: 'contract',
  action: 'verifysourcecode',
  contractaddress: deployment.address,
  sourceCode: JSON.stringify(standardInput),
  codeformat: 'solidity-standard-json-input',
  contractname: `${sourceName}:OutDock`,
  compilerversion: compilerVersion,
  optimizationUsed: '1',
  runs: '200',
  constructorArguments,
  licenseType: '3',
})
if (submitted.status !== '1') {
  if (String(submitted.result).toLowerCase().includes('already verified')) {
    console.log(JSON.stringify({ verified: true, result: submitted.result }))
    process.exit(0)
  }
  throw new Error(`Etherscan verification submission failed: ${submitted.result}`)
}

const guid = submitted.result
for (let attempt = 1; attempt <= 12; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  const status = await etherscan({ module: 'contract', action: 'checkverifystatus', guid })
  const result = String(status.result)
  if (status.status === '1' || result.toLowerCase().includes('already verified')) {
    console.log(JSON.stringify({ verified: true, guid, result }))
    process.exit(0)
  }
  if (!result.toLowerCase().includes('pending')) throw new Error(`Etherscan verification failed: ${result}`)
  console.log(JSON.stringify({ verified: false, pending: true, attempt }))
}
throw new Error('Etherscan verification remained pending after 60 seconds')
