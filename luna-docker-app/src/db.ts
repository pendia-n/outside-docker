import type { D1Database } from '@cloudflare/workers-types'
import { generateSalt } from './lib/crypto'

export type Kind = 'human' | 'machine'
export type ApiKeyRecord = { id: string; tenantId: string; keyHash: string; label: string; machineOnly: boolean; active: boolean }
export type ChainRecord = { id: string; tenantId: string; kind: Kind; externalRef: string; chainSalt: string; headProof: string | null; eventCount: number }
export type EventRecord = {
  id: string; tenantId: string; chainId: string; kind: Kind; idempotencyKey: string; ciphertext: string; encryptionNonce: string
  payloadHash: string; proof: string; previousProof: string | null; chainPosition: number; receivedAt: string; createdAt: string
}
export type AnchorRecord = { id: string; merkleRoot: string; leafCount: number; network: string; networkChainId: number; txHash: string | null; blockNumber: number | null; status: 'pending' | 'submitted' | 'confirmed' | 'failed'; submittedAt: string | null; confirmedAt: string | null; createdAt: string }

export interface Store {
  findApiKey(keyHash: string): Promise<ApiKeyRecord | null>
  ensureTenant(id: string, name: string): Promise<void>
  ensureApiKey(record: ApiKeyRecord): Promise<void>
  getChain(tenantId: string, kind: Kind, externalRef: string): Promise<ChainRecord | null>
  createChain(chain: ChainRecord): Promise<void>
  getLatestEvent(chainId: string): Promise<EventRecord | null>
  findEventByIdempotency(tenantId: string, idempotencyKey: string): Promise<EventRecord | null>
  insertEvent(event: EventRecord): Promise<void>
  updateChain(chainId: string, headProof: string, eventCount: number): Promise<void>
  findEventByProof(proof: string): Promise<EventRecord | null>
  listChainEvents(chainId: string): Promise<EventRecord[]>
  saveAnchor(anchor: AnchorRecord): Promise<void>
  findAnchorByRoot(root: string): Promise<AnchorRecord | null>
}

function rowToApiKey(row: Record<string, unknown>): ApiKeyRecord {
  return { id: String(row.id), tenantId: String(row.tenant_id), keyHash: String(row.key_hash), label: String(row.label), machineOnly: Boolean(row.machine_only), active: Boolean(row.is_active) }
}
function rowToChain(row: Record<string, unknown>): ChainRecord {
  return { id: String(row.id), tenantId: String(row.tenant_id), kind: row.kind as Kind, externalRef: String(row.external_ref), chainSalt: String(row.chain_salt), headProof: row.head_proof ? String(row.head_proof) : null, eventCount: Number(row.event_count) }
}
function rowToEvent(row: Record<string, unknown>): EventRecord {
  return { id: String(row.id), tenantId: String(row.tenant_id), chainId: String(row.chain_id), kind: row.kind as Kind, idempotencyKey: String(row.idempotency_key), ciphertext: String(row.ciphertext), encryptionNonce: String(row.encryption_nonce), payloadHash: String(row.payload_hash), proof: String(row.proof), previousProof: row.previous_proof ? String(row.previous_proof) : null, chainPosition: Number(row.chain_position), receivedAt: String(row.received_at), createdAt: String(row.created_at) }
}

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}
  async findApiKey(keyHash: string) { const row = await this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1').bind(keyHash).first<Record<string, unknown>>(); return row ? rowToApiKey(row) : null }
  async ensureTenant(id: string, name: string) { await this.db.prepare('INSERT OR IGNORE INTO tenants (id,name,created_at) VALUES (?,?,?)').bind(id, name, new Date().toISOString()).run() }
  async ensureApiKey(record: ApiKeyRecord) { await this.db.prepare('INSERT OR IGNORE INTO api_keys (id,tenant_id,key_hash,label,machine_only,is_active,created_at) VALUES (?,?,?,?,?,?,?)').bind(record.id, record.tenantId, record.keyHash, record.label, record.machineOnly ? 1 : 0, record.active ? 1 : 0, new Date().toISOString()).run() }
  async getChain(tenantId: string, kind: Kind, externalRef: string) { const row = await this.db.prepare('SELECT * FROM chains WHERE tenant_id = ? AND kind = ? AND external_ref = ?').bind(tenantId, kind, externalRef).first<Record<string, unknown>>(); return row ? rowToChain(row) : null }
  async createChain(chain: ChainRecord) { await this.db.prepare('INSERT INTO chains (id,tenant_id,kind,external_ref,chain_salt,head_proof,event_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(chain.id, chain.tenantId, chain.kind, chain.externalRef, chain.chainSalt, chain.headProof, chain.eventCount, new Date().toISOString(), new Date().toISOString()).run() }
  async getLatestEvent(chainId: string) { const row = await this.db.prepare('SELECT * FROM events WHERE chain_id = ? ORDER BY chain_position DESC LIMIT 1').bind(chainId).first<Record<string, unknown>>(); return row ? rowToEvent(row) : null }
  async findEventByIdempotency(tenantId: string, idempotencyKey: string) { const row = await this.db.prepare('SELECT * FROM events WHERE tenant_id = ? AND idempotency_key = ?').bind(tenantId, idempotencyKey).first<Record<string, unknown>>(); return row ? rowToEvent(row) : null }
  async insertEvent(event: EventRecord) { await this.db.prepare('INSERT INTO events (id,tenant_id,chain_id,kind,idempotency_key,ciphertext,encryption_nonce,payload_hash,proof,previous_proof,chain_position,received_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(event.id, event.tenantId, event.chainId, event.kind, event.idempotencyKey, event.ciphertext, event.encryptionNonce, event.payloadHash, event.proof, event.previousProof, event.chainPosition, event.receivedAt, event.createdAt).run() }
  async updateChain(chainId: string, headProof: string, eventCount: number) { await this.db.prepare('UPDATE chains SET head_proof = ?, event_count = ?, updated_at = ? WHERE id = ?').bind(headProof, eventCount, new Date().toISOString(), chainId).run() }
  async findEventByProof(proof: string) { const row = await this.db.prepare('SELECT * FROM events WHERE proof = ?').bind(proof).first<Record<string, unknown>>(); return row ? rowToEvent(row) : null }
  async listChainEvents(chainId: string) { const result = await this.db.prepare('SELECT * FROM events WHERE chain_id = ? ORDER BY chain_position ASC').bind(chainId).all<Record<string, unknown>>(); return result.results.map(rowToEvent) }
  async saveAnchor(anchor: AnchorRecord) { await this.db.prepare('INSERT OR REPLACE INTO anchor_batches (id,merkle_root,leaf_count,network,network_chain_id,tx_hash,block_number,status,submitted_at,confirmed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(anchor.id, anchor.merkleRoot, anchor.leafCount, anchor.network, anchor.networkChainId, anchor.txHash, anchor.blockNumber, anchor.status, anchor.submittedAt, anchor.confirmedAt, anchor.createdAt).run() }
  async findAnchorByRoot(root: string) { const row = await this.db.prepare('SELECT * FROM anchor_batches WHERE merkle_root = ?').bind(root).first<Record<string, unknown>>(); if (!row) return null; return { id: String(row.id), merkleRoot: String(row.merkle_root), leafCount: Number(row.leaf_count), network: String(row.network), networkChainId: Number(row.network_chain_id), txHash: row.tx_hash ? String(row.tx_hash) : null, blockNumber: row.block_number ? Number(row.block_number) : null, status: row.status as AnchorRecord['status'], submittedAt: row.submitted_at ? String(row.submitted_at) : null, confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null, createdAt: String(row.created_at) } }
}

export class MemoryStore implements Store {
  tenants = new Map<string, string>(); apiKeys = new Map<string, ApiKeyRecord>(); chains = new Map<string, ChainRecord>(); events: EventRecord[] = []; anchors = new Map<string, AnchorRecord>()
  async findApiKey(keyHash: string) { return Array.from(this.apiKeys.values()).find((key) => key.keyHash === keyHash && key.active) ?? null }
  async ensureTenant(id: string, name: string) { this.tenants.set(id, name) }
  async ensureApiKey(record: ApiKeyRecord) { this.apiKeys.set(record.id, record) }
  async getChain(tenantId: string, kind: Kind, externalRef: string) { return Array.from(this.chains.values()).find((chain) => chain.tenantId === tenantId && chain.kind === kind && chain.externalRef === externalRef) ?? null }
  async createChain(chain: ChainRecord) { this.chains.set(chain.id, chain) }
  async getLatestEvent(chainId: string) { return [...this.events].filter((event) => event.chainId === chainId).sort((a, b) => b.chainPosition - a.chainPosition)[0] ?? null }
  async findEventByIdempotency(tenantId: string, idempotencyKey: string) { return this.events.find((event) => event.tenantId === tenantId && event.idempotencyKey === idempotencyKey) ?? null }
  async insertEvent(event: EventRecord) { if (this.events.some((item) => item.chainId === event.chainId && item.chainPosition === event.chainPosition)) throw new Error('UNIQUE chain position'); this.events.push(event) }
  async updateChain(chainId: string, headProof: string, eventCount: number) { const chain = this.chains.get(chainId); if (chain) { chain.headProof = headProof; chain.eventCount = eventCount } }
  async findEventByProof(proof: string) { return this.events.find((event) => event.proof === proof) ?? null }
  async listChainEvents(chainId: string) { return [...this.events].filter((event) => event.chainId === chainId).sort((a, b) => a.chainPosition - b.chainPosition) }
  async saveAnchor(anchor: AnchorRecord) { this.anchors.set(anchor.merkleRoot, anchor) }
  async findAnchorByRoot(root: string) { return this.anchors.get(root) ?? null }
}

let fallbackStore: MemoryStore | undefined
export function getStore(env: { OD_DB?: D1Database }): Store { if (env.OD_DB) return new D1Store(env.OD_DB); fallbackStore ??= new MemoryStore(); return fallbackStore }
export { generateSalt }
