import type { Context } from 'hono'
import { getStore, type ApiKeyRecord } from '../db'
import { sha256Hex } from '../lib/crypto'
import type { AppEnv } from '../index'

export type AuthContext = { apiKey: ApiKeyRecord }

export async function seedDevelopmentCredentials(env: AppEnv['Bindings']) {
  if (env.APP_ENV !== 'development') return
  const store = getStore(env)
  const pepper = env.API_KEY_PEPPER ?? 'development-only-pepper'
  await store.ensureTenant('synthetic-tenant', 'Synthetic Development Tenant')
  const credentials = [
    { raw: env.DEV_API_KEY, id: 'synthetic-human-key', label: 'Synthetic human key', machineOnly: false },
    { raw: env.DEV_MACHINE_API_KEY, id: 'synthetic-machine-key', label: 'Synthetic machine key', machineOnly: true },
  ]
  for (const credential of credentials) {
    if (!credential.raw) continue
    await store.ensureApiKey({ id: credential.id, tenantId: 'synthetic-tenant', keyHash: await sha256Hex(`${credential.raw}:${pepper}`), label: credential.label, machineOnly: credential.machineOnly, active: true })
  }
}

export async function authenticate(c: Context<AppEnv>, machineOnly = false): Promise<AuthContext | Response> {
  await seedDevelopmentCredentials(c.env)
  const header = c.req.header('Authorization')
  const raw = header?.startsWith('Bearer ') ? header.slice(7) : null
  if (!raw) return c.json({ error: 'missing_api_key' }, 401)
  const pepper = c.env.API_KEY_PEPPER ?? 'development-only-pepper'
  const key = await getStore(c.env).findApiKey(await sha256Hex(`${raw}:${pepper}`))
  if (!key) return c.json({ error: 'invalid_api_key' }, 401)
  if (machineOnly && !key.machineOnly) return c.json({ error: 'track_m_requires_machine_key' }, 403)
  return { apiKey: key }
}
