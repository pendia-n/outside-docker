import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson, inspectPassword, normalizeOptionalGmail, validateUsername } from './validation'

test('shared registration validation normalizes only allowed Phase 1 identities', () => {
  assert.equal(validateUsername('  Alice_01 '), 'alice_01')
  assert.equal(normalizeOptionalGmail(' Alice.Test+od@GMAIL.COM '), 'alice.test+od@gmail.com')
  assert.equal(normalizeOptionalGmail(' Alice@HOTMAIL.COM '), 'alice@hotmail.com')
  assert.throws(() => normalizeOptionalGmail('alice@example.com'))
  assert.deepEqual(inspectPassword('Correct7!'), { valid: true, issues: [] })
  assert.equal(inspectPassword('weak').valid, false)
  assert.equal(inspectPassword('zxcghjiiop').valid, false)
  assert.equal(inspectPassword('zxcghjiiop1').valid, true)
  assert.equal(inspectPassword('a1'.repeat(10)).valid, false)
})

test('validation delegates to the application canonical JSON implementation', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":1}')
  assert.throws(() => canonicalJson({ unsupported: undefined }))
})
