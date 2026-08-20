import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainError } from './chain-do'
import { assertNoRetainedPayload, validateCaseInput } from './track-h'

test('human case validation keeps pseudonymous references compact', () => {
  assert.deepEqual(validateCaseInput({ case_ref: 'CARE-2026-001', title: 'Incident record' }), {
    case_ref: 'CARE-2026-001',
    title: 'Incident record',
    description: null,
    category: null,
  })
})

test('Track H rejects original and encrypted content at any nesting level', () => {
  assert.throws(() => assertNoRetainedPayload({ metadata: { encrypted_capsule: 'ciphertext' } }), (error: unknown) => {
    assert.ok(error instanceof DomainError)
    assert.equal(error.code, 'original_content_rejected')
    return true
  })
  assert.throws(() => assertNoRetainedPayload({ file_bytes: new Uint8Array([1]) }), DomainError)
})
