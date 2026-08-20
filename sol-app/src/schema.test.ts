import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  database.exec(readFileSync(join(sourceDirectory, '../migrations/0001_init.sql'), 'utf8'))
  database.exec(readFileSync(join(sourceDirectory, '../migrations/0002_phase1.sql'), 'utf8'))
  database.exec(`
    INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'supplier_1', 'hash', 'supplier');
    INSERT INTO chains (id, owner_id, track, external_ref) VALUES ('ch1', 'u1', 'H', 'case-1');
    INSERT INTO events (
      id, chain_id, owner_id, position, commitment, manifest_hash, previous_proof,
      proof, track, external_ref, event_type, received_at, updated_at
    ) VALUES (
      'e1', 'ch1', 'u1', 1, 'commitment', 'manifest', NULL, 'proof',
      'H', 'case-1', 'CAPTURED', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO receipts (
      id, event_id, receipt_json, signature, signing_key_id, issued_at, updated_at
    ) VALUES ('r1', 'e1', '{"receipt":1}', 'signature', 'legacy-key',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `)
  return database
}

test('schema permits anchor projection updates but rejects evidence tampering and deletion', () => {
  const database = migratedDatabase()
  database.exec("UPDATE events SET anchor_status = 'batching', updated_at = '2026-01-02T00:00:00Z' WHERE id = 'e1'")
  database.exec("UPDATE receipts SET anchor_status = 'batching', updated_at = '2026-01-02T00:00:00Z' WHERE id = 'r1'")
  database.exec("UPDATE chains SET previous_proof = 'proof', next_position = 2 WHERE id = 'ch1'")

  assert.throws(() => database.exec("UPDATE events SET commitment = 'tampered' WHERE id = 'e1'"), /immutable/)
  assert.throws(() => database.exec("UPDATE receipts SET receipt_json = '{}' WHERE id = 'r1'"), /immutable/)
  assert.throws(() => database.exec("UPDATE chains SET external_ref = 'other' WHERE id = 'ch1'"), /immutable/)
  assert.throws(() => database.exec("DELETE FROM receipts WHERE id = 'r1'"), /cannot be deleted/)
  assert.throws(() => database.exec("DELETE FROM events WHERE id = 'e1'"), /cannot be deleted/)
})

test('published scope and Merkle membership snapshots are immutable', () => {
  const database = migratedDatabase()
  database.exec(`
    INSERT INTO evidence_scopes (
      id, owner_id, scope_type, scope_ref, title, status, created_at, updated_at
    ) VALUES ('sc1', 'u1', 'case', 'case-1', 'Case 1', 'draft',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO evidence_scope_members (scope_id, event_id, position) VALUES ('sc1', 'e1', 1);
    UPDATE evidence_scopes
      SET status = 'published', published_at = '2026-01-02T00:00:00Z', updated_at = '2026-01-02T00:00:00Z'
      WHERE id = 'sc1';
    INSERT INTO anchor_batches (
      id, environment, batch_ref, status, merkle_root, manifest_hash, leaf_count,
      event_count, chain_id, contract_address
    ) VALUES ('ab1', 'dev', 'batch', 'confirmed', 'root', 'manifest', 1, 1,
              '80002', '0x1111111111111111111111111111111111111111');
    INSERT INTO anchor_batch_events (
      batch_id, event_id, leaf_index, leaf_hash, merkle_proof_json
    ) VALUES ('ab1', 'e1', 0, 'leaf', '[]');
  `)

  assert.throws(() => database.exec("DELETE FROM evidence_scope_members WHERE scope_id = 'sc1'"), /immutable/)
  assert.throws(() => database.exec("UPDATE evidence_scopes SET title = 'Changed' WHERE id = 'sc1'"), /immutable/)
  assert.throws(() => database.exec("UPDATE evidence_scopes SET status = 'draft' WHERE id = 'sc1'"), /cannot return to draft/)
  assert.throws(() => database.exec("UPDATE anchor_batch_events SET leaf_hash = 'other' WHERE event_id = 'e1'"), /immutable/)
  assert.throws(() => database.exec("UPDATE anchor_batches SET merkle_root = 'other' WHERE id = 'ab1'"), /immutable/)
})
