import type { D1Database } from '@cloudflare/workers-types'
import { Hono } from 'hono'
import { eventRoutes, recordRoutes } from './routes/write'
import { readRoutes } from './routes/read'
import { anchorRoutes } from './routes/anchor'
import { renderLandingPage } from './ui'

export type Bindings = {
  APP_ENV?: string
  CHAIN_ID?: string
  NETWORK_NAME?: string
  OD_DB?: D1Database
  API_KEY_PEPPER?: string
  POLYGON_RPC_URL?: string
  POLYGON_PRIVATE_KEY?: string
  POLYGON_CONTRACT_ADDRESS?: string
  ANCHOR_SERVICE_SECRET?: string
  DEV_API_KEY?: string
  DEV_MACHINE_API_KEY?: string
}
export type AppEnv = { Bindings: Bindings }

export const app = new Hono<AppEnv>()
app.get('/', (c) => c.html(renderLandingPage()))
app.get('/health', (c) => c.json({ ok: true, environment: c.env.APP_ENV ?? 'development' }))
app.route('/', eventRoutes)
app.route('/', recordRoutes)
app.route('/', readRoutes)
app.route('/', anchorRoutes)

export default app
