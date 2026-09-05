import { access, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

const generatedSecretsFile = resolve('dist/outside_docker_sol_app/.dev.vars')

try {
  await access(generatedSecretsFile, constants.F_OK)
  await unlink(generatedSecretsFile)
  console.log('Removed local development secrets from the generated Worker bundle.')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
