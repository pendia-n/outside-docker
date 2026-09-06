import fs from 'node:fs'
import path from 'node:path'
import solc from 'solc'

const appRoot = path.resolve(new URL('.', import.meta.url).pathname, '..')
const contractName = 'OutDock'
const sourceName = `${contractName}.sol`
const sourcePath = path.join(appRoot, 'contracts', 'src', sourceName)
const source = fs.readFileSync(sourcePath, 'utf8')
const input = {
  language: 'Solidity',
  sources: { [sourceName]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const failures = (output.errors || []).filter((entry) => entry.severity === 'error')
if (failures.length) throw new Error(failures.map((entry) => entry.formattedMessage).join('\n'))

const contract = output.contracts[sourceName][contractName]
const artifact = {
  contractName,
  sourceName,
  compilerVersion: solc.version(),
  targetNetworks: [
    { name: 'base-sepolia', chainId: 84532, currency: 'ETH' },
    { name: 'base', chainId: 8453, currency: 'ETH' },
  ],
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  metadata: JSON.parse(contract.metadata),
}
const outputPath = path.join(appRoot, 'contracts', `${contractName}.base-build.json`)
fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`)
console.log(`Built ${contractName} for Base-compatible EVM networks: ${outputPath}`)
