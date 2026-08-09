import { describe, expect, it } from 'vitest'
import { app } from '../src/index'

describe('health route', () => {
  it('returns a development health response', async () => {
    const response = await app.fetch(new Request('http://localhost/health'), {
      APP_ENV: 'development',
      CHAIN_ID: '80002',
      NETWORK_NAME: 'polygon-amoy',
    } as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, environment: 'development' })
  })
})
