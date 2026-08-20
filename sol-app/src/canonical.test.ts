import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalizationError, canonicalSha256, canonicalize, parseCanonicalJson } from './canonical'

test('canonicalize is stable across insertion order and nested objects', async () => {
  const left = { z: [3, { b: true, a: 'x' }], a: 1 }
  const right = { a: 1, z: [3, { a: 'x', b: true }] }
  assert.equal(canonicalize(left), '{"a":1,"z":[3,{"a":"x","b":true}]}')
  assert.equal(await canonicalSha256(left), await canonicalSha256(right))
})

test('canonicalize rejects lossy or non-interoperable values', () => {
  assert.throws(() => canonicalize({ value: Number.NaN }), CanonicalizationError)
  assert.throws(() => canonicalize({ value: undefined }), CanonicalizationError)
  assert.throws(() => canonicalize('\ud800'), CanonicalizationError)
  assert.throws(() => canonicalize(new Date()), CanonicalizationError)
})

test('canonicalize renders negative zero as zero', () => {
  assert.equal(canonicalize({ n: -0 }), '{"n":0}')
})

test('parseCanonicalJson accepts only the exact canonical representation', () => {
  assert.deepEqual(parseCanonicalJson('{"a":1,"b":2}'), { a: 1, b: 2 })
  assert.throws(() => parseCanonicalJson('{ "a": 1, "b": 2 }'), CanonicalizationError)
  assert.throws(() => parseCanonicalJson('{"b":2,"a":1}'), CanonicalizationError)
  assert.throws(() => parseCanonicalJson('{"a":0,"a":1}'), CanonicalizationError)
})
