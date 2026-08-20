import { Hono } from 'hono'
import { canonicalize, sha256Bytes } from './canonical'
import { DomainError, computeEventProof } from './chain-do'
import { merkleLeafHash, merkleProofLeafIndex, verifyMerkleProof, type MerkleProofStep } from './merkle'
import { createEd25519ReceiptVerifier, verifyReceiptJson, type ReceiptPayload } from './receipts'
import { createProofPdfResponse } from './pdf'

export interface VerificationActor {
  userId: string
  role: 'supplier' | 'verifier'
}

export type EvidenceScopeType = 'case' | 'delivery' | 'event_group' | 'event' | 'custom'

export interface EvidenceScope {
  id: string
  owner_id: string
  scope_type: EvidenceScopeType
  scope_ref: string
  title: string
  summary: string | null
  status: 'draft' | 'published' | 'revoked' | 'archived'
  published_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateEvidenceScopeInput {
  scope_type: EvidenceScopeType
  scope_ref: string
  title: string
  summary?: string | null
  event_ids?: string[]
}

export interface PortableProofV1 {
  format: 'odproof'
  version: 1
  environment: 'dev' | 'prod'
  event: {
    id: string
    chain_id: string
    external_ref: string
    track: 'H' | 'M'
    event_type: string
    position: number
    commitment: string
    manifest_hash: string
    previous_proof: string | null
    proof: string
    occurred_at: string | null
    received_at: string
    delivery_id?: string | null
    sequence?: number | null
    sequence_status?: string | null
    anchor_status: string
  }
  receipt: {
    payload: ReceiptPayload
    canonical_json: string
    signature: string
    signing_key_id: string
    signature_algorithm: string
    public_key_jwk: JsonWebKey | null
  }
  anchor: null | {
    batch_ref: string
    merkle_root: string
    manifest_hash: string
    leaf_index: number
    leaf_hash: string
    proof: MerkleProofStep[]
    chain_id: string
    network: string | null
    contract_address: string
    transaction_hash: string
    block_number: number | null
    block_hash: string | null
    confirmed_at: string
  }
  disclaimer: string
}

export interface PortableVerificationResult {
  valid: boolean
  receipt_signature: boolean
  event_chain_proof: boolean
  merkle_inclusion: boolean | null
  polygon_anchor: boolean | null
  environment: 'dev' | 'prod' | null
  failures: string[]
}

export interface PortableVerificationOptions {
  /** Keys must come from a trusted OD registry or pinned application config. */
  trustedPublicKeys?: Record<string, JsonWebKey>
  /** Useful only when the caller already obtained the artifact from trusted D1. */
  allowEmbeddedPublicKey?: boolean
  expectedEnvironment?: 'dev' | 'prod'
  verifyPolygonAnchor?: (anchor: NonNullable<PortableProofV1['anchor']>) => Promise<boolean>
  requirePolygon?: boolean
}

const SCOPE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

function stringValue(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum) {
    throw new DomainError(400, 'invalid_request', `${field} is required and must be at most ${maximum} characters`)
  }
  return value.trim()
}

function shareSecret(): string {
  const random = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of random) binary += String.fromCharCode(byte)
  return `od_share_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`
}

export async function hashShareToken(token: string): Promise<string> {
  if (!/^od_share_[A-Za-z0-9_-]{40,80}$/.test(token)) throw new DomainError(404, 'share_not_found', 'Shared proof was not found')
  return sha256Bytes(token)
}

function parseJson<T>(value: string, label: string): T {
  try { return JSON.parse(value) as T }
  catch { throw new DomainError(500, 'invalid_stored_proof', `Stored ${label} is invalid`) }
}

export async function verifyPortableProof(proof: PortableProofV1, options: PortableVerificationOptions = {}): Promise<PortableVerificationResult> {
  const failures: string[] = []
  let signatureValid = false
  let signedReceipt: ReceiptPayload | null = null
  const trustedKey = options.trustedPublicKeys?.[proof.receipt.signing_key_id]
  const verificationKey = trustedKey ?? (options.allowEmbeddedPublicKey ? proof.receipt.public_key_jwk : null)
  if (!verificationKey) {
    failures.push(proof.receipt.public_key_jwk ? 'receipt_key_untrusted' : 'receipt_public_key_missing')
  } else {
    try {
      if (trustedKey && proof.receipt.public_key_jwk && canonicalize(trustedKey) !== canonicalize(proof.receipt.public_key_jwk)) {
        failures.push('embedded_receipt_key_mismatch')
      }
      const verifier = await createEd25519ReceiptVerifier(verificationKey, proof.receipt.signing_key_id)
      const checked = await verifyReceiptJson(proof.receipt.canonical_json, proof.receipt.signature, verifier)
      signatureValid = checked.valid
      if (!checked.valid) failures.push(`receipt_${checked.reason}`)
      else {
        signedReceipt = checked.receipt
        if (
          proof.receipt.canonical_json !== checked.canonicalReceipt
          || canonicalize(proof.receipt.payload) !== checked.canonicalReceipt
        ) {
          failures.push('receipt_payload_mismatch')
        }
        if (signedReceipt.anchor_status !== 'pending_anchor') failures.push('receipt_anchor_state_invalid')
      }
    } catch {
      failures.push('receipt_signature_invalid')
    }
  }

  let chainValid = false
  try {
    const expected = await computeEventProof({
      chainId: proof.event.chain_id,
      position: proof.event.position,
      receivedAt: proof.event.received_at,
      commitment: proof.event.commitment,
      previousProof: proof.event.previous_proof,
    })
    chainValid = Boolean(signedReceipt)
      && expected === proof.event.proof
      && signedReceipt!.event_id === proof.event.id
      && signedReceipt!.chain_id === proof.event.chain_id
      && signedReceipt!.external_ref === proof.event.external_ref
      && signedReceipt!.track === proof.event.track
      && signedReceipt!.event_type === proof.event.event_type
      && signedReceipt!.position === proof.event.position
      && signedReceipt!.commitment === proof.event.commitment
      && signedReceipt!.proof === proof.event.proof
      && signedReceipt!.previous_proof === proof.event.previous_proof
      && signedReceipt!.manifest_hash === proof.event.manifest_hash
      && signedReceipt!.occurred_at === proof.event.occurred_at
      && signedReceipt!.received_at === proof.event.received_at
      && signedReceipt!.delivery_id === (proof.event.delivery_id ?? null)
      && signedReceipt!.sequence === (proof.event.sequence ?? null)
      && signedReceipt!.sequence_status === (proof.event.sequence_status ?? null)
      && signedReceipt!.anchor_status === 'pending_anchor'
      && signedReceipt!.environment === proof.environment
    if (!chainValid) failures.push('event_chain_mismatch')
  } catch {
    failures.push('event_chain_invalid')
  }

  let merkleValid: boolean | null = null
  if (proof.anchor) {
    try {
      merkleValid = await verifyMerkleProof(
        { eventId: proof.event.id, proof: proof.event.proof },
        proof.anchor.proof,
        proof.anchor.merkle_root,
      )
      merkleValid = merkleValid && await merkleLeafHash({ eventId: proof.event.id, proof: proof.event.proof }) === proof.anchor.leaf_hash
      merkleValid = merkleValid && merkleProofLeafIndex(proof.anchor.proof) === proof.anchor.leaf_index
      if (!merkleValid) failures.push('merkle_inclusion_invalid')
    } catch {
      merkleValid = false
      failures.push('merkle_inclusion_invalid')
    }
  }
  if (proof.anchor && proof.event.anchor_status !== 'anchored') {
    failures.push('anchor_state_mismatch')
  }
  if (!proof.anchor && proof.event.anchor_status === 'anchored') {
    merkleValid = false
    failures.push('anchor_data_missing')
  }
  let polygonValid: boolean | null = null
  if (proof.anchor) {
    if (options.verifyPolygonAnchor) {
      try {
        polygonValid = await options.verifyPolygonAnchor(proof.anchor)
        if (!polygonValid) failures.push('polygon_anchor_invalid')
      } catch {
        polygonValid = false
        failures.push('polygon_anchor_unavailable')
      }
    } else if (options.requirePolygon !== false) {
      failures.push('polygon_anchor_unverified')
    }
  }
  if (options.expectedEnvironment && options.expectedEnvironment !== proof.environment) failures.push('environment_mismatch')
  const polygonSatisfied = !proof.anchor || polygonValid === true || options.requirePolygon === false
  return {
    valid: signatureValid && chainValid && (merkleValid !== false) && polygonSatisfied && failures.length === 0,
    receipt_signature: signatureValid,
    event_chain_proof: chainValid,
    merkle_inclusion: merkleValid,
    polygon_anchor: polygonValid,
    environment: proof.environment === 'dev' || proof.environment === 'prod' ? proof.environment : null,
    failures,
  }
}

export class VerifierService {
  constructor(private readonly database: D1Database, private readonly now: () => Date = () => new Date()) {}

  async createScope(ownerId: string, input: CreateEvidenceScopeInput): Promise<EvidenceScope> {
    if (!['case', 'delivery', 'event_group', 'event', 'custom'].includes(input.scope_type)) {
      throw new DomainError(400, 'invalid_scope_type', 'Unsupported evidence scope type')
    }
    const scopeRef = stringValue(input.scope_ref, 'scope_ref', 128)
    if (!SCOPE_REF.test(scopeRef)) throw new DomainError(400, 'invalid_scope_ref', 'scope_ref contains unsupported characters')
    const eventIds = [...new Set(input.event_ids ?? [])]
    if (eventIds.length === 0) throw new DomainError(400, 'empty_scope', 'An evidence scope needs at least one event')
    if (eventIds.length > 80) throw new DomainError(413, 'scope_too_large', 'A Phase 1 evidence scope can contain at most 80 events')
    const placeholders = eventIds.map(() => '?').join(',')
    const owned = await this.database.prepare(
      `SELECT id FROM events WHERE owner_id = ? AND id IN (${placeholders})`,
    ).bind(ownerId, ...eventIds).all<{ id: string }>()
    if (owned.results.length !== eventIds.length) throw new DomainError(400, 'invalid_scope_member', 'Every event must belong to the supplier')

    const id = crypto.randomUUID()
    const createdAt = this.now().toISOString()
    const statements: D1PreparedStatement[] = [this.database.prepare(`
      INSERT INTO evidence_scopes (
        id, owner_id, scope_type, scope_ref, title, summary, status, published_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)
    `).bind(id, ownerId, input.scope_type, scopeRef, stringValue(input.title, 'title', 160), input.summary?.trim() || null, createdAt, createdAt)]
    eventIds.forEach((eventId, index) => {
      statements.push(this.database.prepare(`
        INSERT INTO evidence_scope_members (scope_id, event_id, position, added_by_user_id, added_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(id, eventId, index + 1, ownerId, createdAt))
    })
    try { await this.database.batch(statements) }
    catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) throw new DomainError(409, 'scope_conflict', 'scope_ref already exists')
      throw error
    }
    return this.ownedScope(ownerId, id)
  }

  async addMembers(ownerId: string, scopeId: string, eventIds: string[]): Promise<void> {
    const scope = await this.ownedScope(ownerId, scopeId)
    if (scope.status !== 'draft') throw new DomainError(409, 'scope_already_published', 'Published scope membership is immutable')
    const unique = [...new Set(eventIds)]
    if (unique.length === 0) return
    const existing = await this.database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(MAX(position), 0) AS position
      FROM evidence_scope_members WHERE scope_id = ?
    `).bind(scopeId).first<{ count: number; position: number }>()
    const placeholders = unique.map(() => '?').join(',')
    const currentRows = await this.database.prepare(`
      SELECT event_id FROM evidence_scope_members
      WHERE scope_id = ? AND event_id IN (${placeholders})
    `).bind(scopeId, ...unique).all<{ event_id: string }>()
    const currentIds = new Set(currentRows.results.map((row) => row.event_id))
    const additions = unique.filter((eventId) => !currentIds.has(eventId))
    if (Number(existing?.count ?? 0) + additions.length > 80) {
      throw new DomainError(413, 'scope_too_large', 'A Phase 1 evidence scope can contain at most 80 events')
    }
    const statements: D1PreparedStatement[] = []
    for (let index = 0; index < additions.length; index += 1) {
      const event = await this.database.prepare('SELECT 1 FROM events WHERE id = ? AND owner_id = ? LIMIT 1').bind(additions[index], ownerId).first()
      if (!event) throw new DomainError(400, 'invalid_scope_member', 'Every event must belong to the supplier')
      statements.push(this.database.prepare(`
        INSERT INTO evidence_scope_members (scope_id, event_id, position, added_by_user_id, added_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(scopeId, additions[index], Number(existing?.position ?? 0) + index + 1, ownerId, this.now().toISOString()))
    }
    if (statements.length) await this.database.batch(statements)
  }

  async publishScope(ownerId: string, scopeId: string): Promise<EvidenceScope> {
    await this.ownedScope(ownerId, scopeId)
    const count = await this.database.prepare('SELECT COUNT(*) AS count FROM evidence_scope_members WHERE scope_id = ?').bind(scopeId).first<{ count: number }>()
    if (!count?.count) throw new DomainError(400, 'empty_scope', 'Cannot publish an empty scope')
    const now = this.now().toISOString()
    await this.database.prepare(`
      UPDATE evidence_scopes SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ?
      WHERE id = ? AND owner_id = ? AND status IN ('draft', 'published')
    `).bind(now, now, scopeId, ownerId).run()
    return this.ownedScope(ownerId, scopeId)
  }

  async ownedScope(ownerId: string, scopeId: string): Promise<EvidenceScope> {
    const scope = await this.database.prepare(`
      SELECT id, owner_id, scope_type, scope_ref, title, summary, status, published_at, created_at, updated_at
      FROM evidence_scopes WHERE id = ? AND owner_id = ? LIMIT 1
    `).bind(scopeId, ownerId).first<EvidenceScope>()
    if (!scope) throw new DomainError(404, 'scope_not_found', 'Evidence scope not found')
    return scope
  }

  private async assertReadPass(verifierId: string, scopeId: string): Promise<void> {
    const now = this.now().toISOString()
    const entitlement = await this.database.prepare(`
      SELECT 1 FROM entitlements e JOIN users u ON u.id = e.user_id
      WHERE e.user_id = ? AND u.role = 'verifier' AND u.is_active = 1
        AND e.kind = 'read_pass' AND e.scope_id = ? AND e.status = 'active'
        AND e.valid_from <= ? AND e.valid_until > ? LIMIT 1
    `).bind(verifierId, scopeId, now, now).first()
    if (!entitlement) throw new DomainError(403, 'read_pass_required', 'An active Read Pass is required for this scope')
  }

  async paidScope(verifierId: string, scopeId: string): Promise<EvidenceScope> {
    await this.assertReadPass(verifierId, scopeId)
    const scope = await this.database.prepare(`
      SELECT id, owner_id, scope_type, scope_ref, title, summary, status, published_at, created_at, updated_at
      FROM evidence_scopes WHERE id = ? AND status = 'published' LIMIT 1
    `).bind(scopeId).first<EvidenceScope>()
    if (!scope) throw new DomainError(404, 'scope_not_found', 'Published evidence scope not found')
    return scope
  }

  async paidEvents(verifierId: string, scopeId: string): Promise<Record<string, unknown>[]> {
    await this.paidScope(verifierId, scopeId)
    return this.scopeEventRows(scopeId)
  }

  private async scopeEventRows(scopeId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.database.prepare(`
      SELECT e.id, e.chain_id, e.external_ref, e.track, e.event_type, e.action, e.position,
             e.delivery_id, e.occurred_at, e.received_at, e.sequence, e.sequence_status,
             e.commitment, e.manifest_hash, e.previous_proof, e.proof, e.anchor_status,
             r.receipt_json, r.signature, r.signing_key_id, r.signature_algorithm
      FROM evidence_scope_members m
      JOIN events e ON e.id = m.event_id
      JOIN receipts r ON r.event_id = e.id
      WHERE m.scope_id = ? ORDER BY m.position ASC, e.received_at ASC, e.id ASC
    `).bind(scopeId).all<Record<string, unknown>>()
    return rows.results.map((row) => ({
      ...row,
      // Keep the query-friendly flat fields while also exposing the exact signed
      // receipt shape used by the public timeline and downstream integrations.
      receipt: parseJson<ReceiptPayload>(String(row.receipt_json), 'receipt'),
    }))
  }

  async createShare(ownerId: string, scopeId: string, options: { expires_at?: string | null; include_pdf?: boolean; max_views?: number | null } = {}): Promise<{ share_id: string; token: string; expires_at: string | null }> {
    const scope = await this.ownedScope(ownerId, scopeId)
    if (scope.status !== 'published') throw new DomainError(409, 'scope_not_published', 'Only a published evidence scope can be shared')
    let expiresAt: string | null = null
    if (options.expires_at) {
      const parsed = new Date(options.expires_at)
      if (!Number.isFinite(parsed.valueOf()) || parsed <= this.now()) throw new DomainError(400, 'invalid_expiry', 'expires_at must be in the future')
      expiresAt = parsed.toISOString()
    }
    if (options.max_views != null && (!Number.isSafeInteger(options.max_views) || options.max_views < 1)) throw new DomainError(400, 'invalid_max_views', 'max_views must be a positive integer')
    const token = shareSecret()
    const hash = await hashShareToken(token)
    const id = crypto.randomUUID()
    const createdAt = this.now().toISOString()
    await this.database.prepare(`
      INSERT INTO shares (
        id, owner_id, scope_type, scope_id, token_hash, token_prefix, include_pdf,
        include_proof, status, max_views, view_count, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, 0, ?, ?, ?)
    `).bind(id, ownerId, scope.scope_type, scopeId, hash, token.slice(0, 18), options.include_pdf ? 1 : 0, options.max_views ?? null, expiresAt, createdAt, createdAt).run()
    return { share_id: id, token, expires_at: expiresAt }
  }

  async resolveShare(token: string): Promise<{ scope: EvidenceScope; events: Record<string, unknown>[]; include_pdf: boolean }> {
    const hash = await hashShareToken(token)
    const now = this.now().toISOString()
    const share = await this.database.prepare(`
      SELECT s.id, s.scope_id, s.include_pdf, s.max_views, s.view_count, s.last_accessed_at,
             sc.id AS sc_id, sc.owner_id, sc.scope_type, sc.scope_ref, sc.title,
             sc.summary, sc.status AS scope_status, sc.published_at, sc.created_at, sc.updated_at
      FROM shares s JOIN evidence_scopes sc ON sc.id = s.scope_id
      WHERE s.token_hash = ? AND s.status = 'active' AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > ?)
        AND sc.status = 'published' LIMIT 1
    `).bind(hash, now).first<Record<string, any>>()
    if (!share) throw new DomainError(404, 'share_not_found', 'Shared proof was not found')
    // Listing a scope and fetching its proof/PDF are one bearer-token view when
    // they happen within ten minutes. This prevents max_views=1 from breaking a
    // normal verification flow while still bounding later independent views.
    const continuation = share.last_accessed_at
      && this.now().valueOf() - new Date(share.last_accessed_at).valueOf() < 10 * 60 * 1000
    if (!continuation && share.max_views != null && share.view_count >= share.max_views) {
      throw new DomainError(404, 'share_not_found', 'Shared proof was not found')
    }
    const touched = continuation
      ? await this.database.prepare(`
          UPDATE shares SET last_accessed_at = ?, updated_at = ? WHERE id = ? AND status = 'active'
        `).bind(now, now, share.id).run()
      : await this.database.prepare(`
          UPDATE shares SET view_count = view_count + 1, last_accessed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'active' AND (max_views IS NULL OR view_count < max_views)
        `).bind(now, now, share.id).run()
    if (!touched.meta.changes) throw new DomainError(404, 'share_not_found', 'Shared proof was not found')
    const scope: EvidenceScope = {
      id: share.sc_id,
      owner_id: share.owner_id,
      scope_type: share.scope_type,
      scope_ref: share.scope_ref,
      title: share.title,
      summary: share.summary,
      status: share.scope_status,
      published_at: share.published_at,
      created_at: share.created_at,
      updated_at: share.updated_at,
    }
    return { scope, events: await this.scopeEventRows(scope.id), include_pdf: Boolean(share.include_pdf) }
  }

  async portableProof(eventId: string, allowedOwnerId?: string, allowedScopeId?: string): Promise<PortableProofV1> {
    const conditions = ['e.id = ?']
    const binds: unknown[] = [eventId]
    if (allowedOwnerId) { conditions.push('e.owner_id = ?'); binds.push(allowedOwnerId) }
    if (allowedScopeId) {
      conditions.push('EXISTS (SELECT 1 FROM evidence_scope_members sm WHERE sm.event_id = e.id AND sm.scope_id = ?)')
      binds.push(allowedScopeId)
    }
    const row = await this.database.prepare(`
      SELECT e.id, e.chain_id, e.external_ref, e.track, e.event_type, e.position,
             e.commitment, e.manifest_hash, e.previous_proof, e.proof, e.occurred_at,
             e.received_at, e.delivery_id, e.sequence, e.sequence_status, e.anchor_status,
             r.receipt_json, r.signature,
             r.signing_key_id, r.signature_algorithm, r.environment,
             k.public_key_jwk,
             b.batch_ref, b.merkle_root, b.manifest_hash AS anchor_manifest_hash,
             b.chain_id AS polygon_chain_id, b.network, b.contract_address, b.tx_hash,
             b.block_number, b.block_hash, b.confirmed_at,
             be.leaf_index, be.leaf_hash, be.merkle_proof_json
      FROM events e
      JOIN receipts r ON r.event_id = e.id
      LEFT JOIN receipt_signing_keys k ON k.id = r.signing_key_id
      LEFT JOIN anchor_batch_events be ON be.event_id = e.id
      LEFT JOIN anchor_batches b ON b.id = be.batch_id AND b.status = 'confirmed'
      WHERE ${conditions.join(' AND ')} LIMIT 1
    `).bind(...binds).first<Record<string, any>>()
    if (!row) throw new DomainError(404, 'proof_not_found', 'Portable proof not found')
    const payload = parseJson<ReceiptPayload>(row.receipt_json, 'receipt')
    const anchored = row.tx_hash && row.merkle_root && row.merkle_proof_json
    return {
      format: 'odproof',
      version: 1,
      environment: row.environment ?? payload.environment,
      event: {
        id: row.id,
        chain_id: row.chain_id,
        external_ref: row.external_ref,
        track: row.track,
        event_type: row.event_type,
        position: row.position,
        commitment: row.commitment,
        manifest_hash: row.manifest_hash,
        previous_proof: row.previous_proof,
        proof: row.proof,
        occurred_at: row.occurred_at,
        received_at: row.received_at,
        delivery_id: row.delivery_id,
        sequence: row.sequence,
        sequence_status: row.sequence_status,
        anchor_status: row.anchor_status,
      },
      receipt: {
        payload,
        canonical_json: row.receipt_json,
        signature: row.signature,
        signing_key_id: row.signing_key_id,
        signature_algorithm: row.signature_algorithm,
        public_key_jwk: row.public_key_jwk ? parseJson<JsonWebKey>(row.public_key_jwk, 'public key') : null,
      },
      anchor: anchored ? {
        batch_ref: row.batch_ref,
        merkle_root: row.merkle_root,
        manifest_hash: row.anchor_manifest_hash,
        leaf_index: row.leaf_index,
        leaf_hash: row.leaf_hash,
        proof: parseJson<MerkleProofStep[]>(row.merkle_proof_json, 'Merkle proof'),
        chain_id: row.polygon_chain_id,
        network: row.network,
        contract_address: row.contract_address,
        transaction_hash: row.tx_hash,
        block_number: row.block_number,
        block_hash: row.block_hash,
        confirmed_at: row.confirmed_at,
      } : null,
      disclaimer: 'Integrity verification shows consistency and ordering; it does not establish substantive truth or legal admissibility.',
    }
  }
}

export interface VerifierRoutesDependencies {
  database(context: any): D1Database
  authenticate(context: any): Promise<VerificationActor | null>
  authorizeSupplierPublish(actor: VerificationActor, context: any): Promise<void>
}

function verifierRouteError(context: any, error: unknown) {
  if (error instanceof DomainError) return context.json({ error: error.message, code: error.code }, error.status)
  throw error
}

function verifyDatabaseProof(proof: PortableProofV1): Promise<PortableVerificationResult> {
  const trustedPublicKeys = proof.receipt.public_key_jwk
    ? { [proof.receipt.signing_key_id]: proof.receipt.public_key_jwk }
    : {}
  return verifyPortableProof(proof, {
    trustedPublicKeys,
    expectedEnvironment: proof.environment,
    // The PDF labels Polygon as not checked unless a route injects an RPC verifier.
    requirePolygon: false,
  })
}

/** Mount under `/api/evidence`; `/share/:token` intentionally needs no account. */
export function createVerifierRoutes(dependencies: VerifierRoutesDependencies): Hono {
  const routes = new Hono()
  const service = (context: any) => new VerifierService(dependencies.database(context))
  const actor = async (context: any, role: 'supplier' | 'verifier') => {
    const authenticated = await dependencies.authenticate(context)
    if (!authenticated) throw new DomainError(401, 'authentication_required', 'Login required')
    if (authenticated.role !== role) throw new DomainError(403, `${role}_required`, `${role} access required`)
    return authenticated
  }

  routes.post('/scopes', async (context) => {
    try {
      const authenticated = await actor(context, 'supplier')
      await dependencies.authorizeSupplierPublish(authenticated, context)
      return context.json(await service(context).createScope(authenticated.userId, await context.req.json()), 201)
    } catch (error) { return verifierRouteError(context, error) }
  })
  routes.post('/scopes/:scopeId/members', async (context) => {
    try {
      const authenticated = await actor(context, 'supplier')
      await dependencies.authorizeSupplierPublish(authenticated, context)
      const body = await context.req.json<{ event_ids?: string[] }>()
      await service(context).addMembers(authenticated.userId, context.req.param('scopeId'), body.event_ids ?? [])
      return context.json({ updated: true })
    } catch (error) { return verifierRouteError(context, error) }
  })
  routes.post('/scopes/:scopeId/publish', async (context) => {
    try {
      const authenticated = await actor(context, 'supplier')
      await dependencies.authorizeSupplierPublish(authenticated, context)
      return context.json(await service(context).publishScope(authenticated.userId, context.req.param('scopeId')))
    } catch (error) { return verifierRouteError(context, error) }
  })
  routes.post('/scopes/:scopeId/shares', async (context) => {
    try {
      const authenticated = await actor(context, 'supplier')
      await dependencies.authorizeSupplierPublish(authenticated, context)
      return context.json(await service(context).createShare(authenticated.userId, context.req.param('scopeId'), await context.req.json()), 201)
    } catch (error) { return verifierRouteError(context, error) }
  })
  routes.get('/scopes/:scopeId/events/:eventId/proof', async (context) => {
    try {
      const authenticated = await actor(context, 'supplier')
      await service(context).ownedScope(authenticated.userId, context.req.param('scopeId'))
      return context.json(await service(context).portableProof(context.req.param('eventId'), authenticated.userId, context.req.param('scopeId')))
    } catch (error) { return verifierRouteError(context, error) }
  })
  routes.get('/scopes/:scopeId/events/:eventId/proof.pdf', async (context) => {
    try {
      const authenticated = await actor(context, 'supplier')
      await service(context).ownedScope(authenticated.userId, context.req.param('scopeId'))
      const proof = await service(context).portableProof(context.req.param('eventId'), authenticated.userId, context.req.param('scopeId'))
      return createProofPdfResponse(proof, { verification: await verifyDatabaseProof(proof) })
    } catch (error) { return verifierRouteError(context, error) }
  })
  routes.get('/verifier/scopes/:scopeId', async (context) => {
    try { return context.json(await service(context).paidScope((await actor(context, 'verifier')).userId, context.req.param('scopeId'))) }
    catch (error) { return verifierRouteError(context, error) }
  })
  routes.get('/verifier/scopes/:scopeId/events', async (context) => {
    try { return context.json({ events: await service(context).paidEvents((await actor(context, 'verifier')).userId, context.req.param('scopeId')) }) }
    catch (error) { return verifierRouteError(context, error) }
  })
  routes.get('/verifier/scopes/:scopeId/events/:eventId/proof', async (context) => {
    try {
      const authenticated = await actor(context, 'verifier')
      await service(context).paidScope(authenticated.userId, context.req.param('scopeId'))
      return context.json(await service(context).portableProof(context.req.param('eventId'), undefined, context.req.param('scopeId')))
    } catch (error) { return verifierRouteError(context, error) }
  })
  routes.get('/verifier/scopes/:scopeId/events/:eventId/proof.pdf', async (context) => {
    try {
      const authenticated = await actor(context, 'verifier')
      await service(context).paidScope(authenticated.userId, context.req.param('scopeId'))
      const proof = await service(context).portableProof(context.req.param('eventId'), undefined, context.req.param('scopeId'))
      return createProofPdfResponse(proof, { verification: await verifyDatabaseProof(proof) })
    } catch (error) { return verifierRouteError(context, error) }
  })
  routes.get('/share/:token', async (context) => {
    try { return context.json(await service(context).resolveShare(context.req.param('token'))) }
    catch (error) { return verifierRouteError(context, error) }
  })
  routes.get('/share/:token/events/:eventId/proof', async (context) => {
    try {
      const shared = await service(context).resolveShare(context.req.param('token'))
      return context.json(await service(context).portableProof(context.req.param('eventId'), undefined, shared.scope.id))
    } catch (error) { return verifierRouteError(context, error) }
  })
  routes.get('/share/:token/events/:eventId/proof.pdf', async (context) => {
    try {
      const shared = await service(context).resolveShare(context.req.param('token'))
      if (!shared.include_pdf) throw new DomainError(403, 'pdf_not_shared', 'This share does not include PDF export')
      const proof = await service(context).portableProof(context.req.param('eventId'), undefined, shared.scope.id)
      return createProofPdfResponse(proof, { verification: await verifyDatabaseProof(proof) })
    } catch (error) { return verifierRouteError(context, error) }
  })
  return routes
}
