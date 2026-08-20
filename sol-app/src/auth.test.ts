import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PASSWORD_HASH_POLICY,
  assertCsrfProtection,
  authenticateCurrentUser,
  authorizeCurrentUser,
  hashPassword,
  issueCsrfToken,
  issueSessionToken,
  verifyAndUpgradePasswordHash,
  verifyLoginPassword,
  verifySessionToken,
  verifySessionTokenDetailed,
  type ActiveEntitlement,
  type CurrentUser,
} from './auth'

const sessionSecret = 'session-secret-that-is-longer-than-thirty-two-bytes'
const issuedAtMs = Date.UTC(2026, 7, 20, 0, 0, 0)

test('legacy PBKDF2 hashes parse, verify, and upgrade after a valid password', async () => {
  const legacy = await hashPassword('Correct7!', { version: 1, iterations: 100_000, saltBytes: 16, digestBytes: 32 })
  const verified = await verifyAndUpgradePasswordHash('Correct7!', legacy, DEFAULT_PASSWORD_HASH_POLICY)
  assert.equal(verified.valid, true)
  assert.equal(verified.needsUpgrade, true)
  assert.match(verified.replacementHash ?? '', /^pbkdf2-sha256\$v=2\$i=100000\$/)
  assert.equal((await verifyAndUpgradePasswordHash('Wrong7!', legacy)).valid, false)
  assert.equal((await verifyLoginPassword('Correct7!', null)).valid, false)
})

test('session JWT verification is strict, environment-bound, and rechecks current state', async () => {
  const token = await issueSessionToken({
    userId: 'user-1',
    username: 'alice_01',
    role: 'supplier',
    sessionVersion: 3,
    tokenId: 'abcdefghijklmnop',
  }, { secret: sessionSecret, environment: 'dev', now: () => issuedAtMs })
  const claims = await verifySessionToken(token, { secret: sessionSecret, environment: 'dev', now: () => issuedAtMs + 1000 })
  assert.equal(claims?.environment, 'dev')
  assert.equal(claims?.session_version, 3)
  assert.equal(await verifySessionToken(token, { secret: sessionSecret, environment: 'prod', now: () => issuedAtMs }), null)

  const user: CurrentUser = {
    id: 'user-1', username: 'alice_01', role: 'supplier', active: true, disabledAt: null,
    sessionVersion: 3, totpEnabled: false, totpRequired: false,
  }
  const authenticated = await authenticateCurrentUser(token, { secret: sessionSecret, environment: 'dev', now: () => issuedAtMs }, {
    async findCurrentUser() { return user },
  })
  const entitlement: ActiveEntitlement = {
        id: 'ent-1', userId: user.id, kind: 'writer_plan', scopeId: null, planCode: 'A', status: 'active',
    validFrom: '2026-08-19T00:00:00.000Z', validUntil: '2026-09-20T00:00:00.000Z', autoRenew: true,
  }
  const authorized = await authorizeCurrentUser(authenticated, {
    roles: ['supplier'], entitlement: { kind: 'writer_plan' },
  }, { async listEntitlements() { return [entitlement] } }, new Date(issuedAtMs))
  assert.equal(authorized.entitlement?.id, entitlement.id)

  await assert.rejects(() => authenticateCurrentUser(token, { secret: sessionSecret, environment: 'dev', now: () => issuedAtMs }, {
    async findCurrentUser() { return { ...user, sessionVersion: 4 } },
  }), /Session is no longer valid/)

  const parts = token.split('.')
  const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}x`
  assert.equal((await verifySessionTokenDetailed(tampered, { secret: sessionSecret, environment: 'dev', now: () => issuedAtMs })).valid, false)
})

test('origin-bound double-submit CSRF tokens are session-bound', async () => {
  const csrfSecret = 'csrf-secret-that-is-also-longer-than-thirty-two-bytes'
  const token = await issueCsrfToken(csrfSecret, 'abcdefghijklmnop')
  const request = {
    method: 'POST',
    headers: new Headers({
      origin: 'https://app.outside-docker.example',
      cookie: `od_csrf=${token}`,
      'x-csrf-token': token,
      'sec-fetch-site': 'same-origin',
    }),
  }
  await assert.doesNotReject(() => assertCsrfProtection(request, {
    allowedOrigins: ['https://app.outside-docker.example'], secret: csrfSecret, sessionId: 'abcdefghijklmnop',
  }))
  await assert.rejects(() => assertCsrfProtection({ ...request, headers: new Headers({ ...Object.fromEntries(request.headers), origin: 'https://evil.example' }) }, {
    allowedOrigins: ['https://app.outside-docker.example'], secret: csrfSecret, sessionId: 'abcdefghijklmnop',
  }))
})
