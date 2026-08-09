import { sha256Hex } from '../src/lib/crypto'

async function main() {
  const tenant = 'synthetic-tenant'
  const human = process.env.DEV_API_KEY ?? 'dev-human-local-only'
  const machine = process.env.DEV_MACHINE_API_KEY ?? 'dev-machine-local-only'
  const pepper = process.env.API_KEY_PEPPER ?? 'development-only-pepper'
  console.log('Synthetic development tenant:', tenant)
  console.log('Human key hash:', await sha256Hex(`${human}:${pepper}`))
  console.log('Machine key hash:', await sha256Hex(`${machine}:${pepper}`))
  console.log('Use only with APP_ENV=development. Never place these values in production secrets or customer data.')
}

void main()
