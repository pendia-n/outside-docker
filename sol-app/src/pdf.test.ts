import assert from 'node:assert/strict'
import test from 'node:test'
import { createProofPdf } from './pdf'
import type { PortableProofV1 } from './verifier'

const fixture = {
  format: 'odproof', version: 1, environment: 'dev',
  event: {
    id: 'event-1', chain_id: 'chain-1', external_ref: 'CASE-1', track: 'H', event_type: 'CAPTURED',
    position: 1, commitment: 'a'.repeat(64), manifest_hash: 'b'.repeat(64), previous_proof: null,
    proof: 'c'.repeat(64), occurred_at: null, received_at: '2026-01-01T00:00:00.000Z', anchor_status: 'pending_anchor',
  },
  receipt: {
    payload: {} as PortableProofV1['receipt']['payload'], canonical_json: '{}', signature: 'signature',
    signing_key_id: 'key-1', signature_algorithm: 'Ed25519', public_key_jwk: null,
  },
  anchor: null,
  disclaimer: 'Integrity does not establish truth.',
} satisfies PortableProofV1

test('PDF export is a complete in-memory PDF with an xref and EOF marker', () => {
  const text = new TextDecoder().decode(createProofPdf(fixture, { generatedAt: new Date('2026-01-02T00:00:00Z') }))
  assert.ok(text.startsWith('%PDF-1.4'))
  assert.match(text, /xref\n0 \d+/)
  assert.ok(text.endsWith('%%EOF\n'))
  assert.match(text, /event-1/)
})
