import assert from 'node:assert/strict'
import test from 'node:test'
import {
  confirmTotpEnrollment,
  createTotpEnrollment,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpCode,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotpCode,
} from './totp'

const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

test('TOTP generation matches RFC 6238 SHA-1 vector and rejects replayed counters', async () => {
  const parameters = { algorithm: 'SHA1' as const, digits: 8 as const, period: 30 }
  assert.equal(await generateTotpCode(rfcSecret, 59_000, parameters), '94287082')
  const first = await verifyTotpCode(rfcSecret, '94287082', { timestampMs: 59_000, window: 0, parameters })
  assert.equal(first.valid, true)
  const replay = await verifyTotpCode(rfcSecret, '94287082', {
    timestampMs: 59_000, window: 0, parameters, lastUsedCounter: first.counter,
  })
  assert.equal(replay.valid, false)
  assert.equal(replay.replayed, true)
})

test('TOTP enrollment secrets are AES-GCM encrypted and confirmed before enablement', async () => {
  const enrollment = createTotpEnrollment('Outside Docker', 'alice_01')
  assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//)
  const key = crypto.getRandomValues(new Uint8Array(32))
  const context = { userId: 'user-1', environment: 'dev' as const, keyId: 'totp-dev-v1' }
  const envelope = await encryptTotpSecret(enrollment.secret, key, context)
  assert.equal(await decryptTotpSecret(envelope, key, context), enrollment.secret)
  const code = await generateTotpCode(enrollment.secret, 1_777_500_000_000)
  const confirmation = await confirmTotpEnrollment(envelope, key, context, code, { timestampMs: 1_777_500_000_000, window: 0 })
  assert.equal(confirmation.valid, true)
  await assert.rejects(() => decryptTotpSecret(envelope, key, { ...context, userId: 'user-2' }), /could not be decrypted/)
})

test('recovery codes are shown values whose stored representations are keyed hashes', async () => {
  const [code] = generateRecoveryCodes(1)
  const pepper = { keyId: 'recovery-v1', secret: crypto.getRandomValues(new Uint8Array(32)) }
  const stored = await hashRecoveryCode(code, 'user-1', pepper)
  assert.doesNotMatch(stored, new RegExp(code.replaceAll('-', ''), 'i'))
  assert.equal(await verifyRecoveryCode(code.toLowerCase(), stored, 'user-1', pepper), true)
  assert.equal(await verifyRecoveryCode('AAAA-AAAA-AAAA', stored, 'user-1', pepper), false)
})
