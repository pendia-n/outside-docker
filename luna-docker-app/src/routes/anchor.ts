import { Hono } from 'hono'
import { getStore } from '../db'
import { authenticate } from '../middleware/api-key'
import { checkpointForChain, createLocalAnchor } from '../services/anchor-batch'
import type { AppEnv } from '../index'

export const anchorRoutes = new Hono<AppEnv>()

anchorRoutes.post('/anchor', async (c) => {
  const secret = c.req.header('X-Anchor-Service-Secret')
  if (!secret || !c.env.ANCHOR_SERVICE_SECRET || secret !== c.env.ANCHOR_SERVICE_SECRET) return c.json({ error: 'forbidden' }, 403)
  const body = await c.req.json().catch(() => null) as { chain_id?: string } | null
  if (!body?.chain_id) return c.json({ error: 'chain_id_required' }, 400)
  try {
    const anchor = await createLocalAnchor(getStore(c.env), body.chain_id, c.env.NETWORK_NAME ?? 'polygon-amoy', Number(c.env.CHAIN_ID ?? 80002))
    return c.json({ anchor, note: 'Local checkpoint persisted; Polygon submission remains pending until RPC and wallet secrets are configured.' }, 202)
  } catch (error) { return c.json({ error: 'anchor_failed', detail: error instanceof Error ? error.message : 'unknown error' }, 400) }
})

anchorRoutes.get('/anchor/:root', async (c) => {
  const auth = await authenticate(c)
  if (auth instanceof Response) return auth
  const anchor = await getStore(c.env).findAnchorByRoot(c.req.param('root'))
  return anchor ? c.json(anchor) : c.json({ error: 'not_found' }, 404)
})
