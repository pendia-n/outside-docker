import { canonicalize, sha256Bytes } from './canonical'
import {
  RECEIPT_SIGNATURE_ALGORITHM,
  createEd25519ReceiptSigner,
  signReceiptPayload,
  type ReceiptPayload,
  type ReceiptSigner,
} from './receipts'

export { createEd25519ReceiptSigner, RECEIPT_SIGNATURE_ALGORITHM }
export type { ReceiptPayload, ReceiptSigner }

export type EvidenceTrack = 'H' | 'M'
export type CredentialType = 'session' | 'api_key'
export type AnchorStatus = 'pending_anchor' | 'anchored' | 'anchor_failed'

export class DomainError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export interface ChainAppendInput {
  ownerId: string
  track: EvidenceTrack
  externalRef: string
  eventType: string
  commitment: string
  manifestHash: string
  credentialType: CredentialType
  credentialId: string
  idempotencyKey: string
  requestHash: string
  occurredAt?: string | null
  caseId?: string | null
  sourceId?: string | null
  deliveryId?: string | null
  sequence?: number | null
  sourceKeyId?: string | null
  sourceSignature?: string | null
  correctsEventId?: string | null
  metadata?: unknown
}

export interface ChainAppendResult {
  event_id: string
  chain_id: string
  position: number
  proof: string
  previous_proof: string | null
  anchor_status: 'pending_anchor'
  receipt: ReceiptPayload
  receipt_json: string
  signature: string
  signing_key_id: string
  signature_algorithm: string
  signed_receipt: {
    receipt: ReceiptPayload
    receipt_json: string
    signature: string
    signing_key_id: string
    signature_algorithm: string
  }
}

export interface ChainRow {
  id: string
  previous_proof: string | null
  next_position: number
}

export interface IdempotencyRow {
  request_hash: string
  response_json: string | null
  status: string
}

export interface SourceState {
  id: string
  external_ref: string
  owner_id: string
  status: string
  out_of_order_policy: string
  last_sequence: number | null
}

export interface PersistedAppend {
  input: NormalizedChainAppendInput
  chain: ChainRow
  isNewChain: boolean
  eventId: string
  receivedAt: string
  previousProof: string | null
  position: number
  proof: string
  sequenceStatus: string | null
  metadataJson: string | null
  receiptPayloadHash: string
  result: ChainAppendResult
}

export interface ChainRepository {
  findIdempotency(credentialType: CredentialType, credentialId: string, key: string): Promise<IdempotencyRow | null>
  findChain(ownerId: string, track: EvidenceTrack, externalRef: string): Promise<ChainRow | null>
  findCorrectionTarget(eventId: string, ownerId: string): Promise<{ id: string; chain_id: string } | null>
  findSource(sourceId: string, ownerId: string): Promise<SourceState | null>
  commitAppend(append: PersistedAppend): Promise<void>
}

export type NormalizedChainAppendInput = Omit<ChainAppendInput, 'metadata' | 'occurredAt'> & {
  occurredAt: string | null
  metadata?: unknown
}

const HEX_256 = /^[a-f0-9]{64}$/
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const SAFE_EVENT_TYPE = /^[A-Z0-9][A-Z0-9_.:-]{0,95}$/
const SAFE_IDEMPOTENCY = /^[\x21-\x7e]{8,200}$/

function requiredText(value: string, field: string, maximum = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new DomainError(400, 'invalid_request', `${field} is required and must be at most ${maximum} characters`)
  }
  return value
}

function digest(value: string, field: string): string {
  const normalized = value?.toLowerCase().replace(/^sha256:/, '').replace(/^0x/, '')
  if (!HEX_256.test(normalized)) throw new DomainError(400, 'invalid_digest', `${field} must be a SHA-256 hex digest`)
  return normalized
}

function timestamp(value: string | null | undefined, field: string): string | null {
  if (value == null) return null
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.valueOf())) throw new DomainError(400, 'invalid_timestamp', `${field} must be an ISO-8601 timestamp`)
  return parsed.toISOString()
}

export function normalizeChainAppendInput(input: ChainAppendInput): NormalizedChainAppendInput {
  const ownerId = requiredText(input.ownerId, 'ownerId')
  const externalRef = requiredText(input.externalRef, 'externalRef')
  const eventType = requiredText(input.eventType, 'eventType', 96).toUpperCase()
  if (input.track !== 'H' && input.track !== 'M') throw new DomainError(400, 'invalid_track', 'track must be H or M')
  if (!SAFE_REFERENCE.test(externalRef)) throw new DomainError(400, 'invalid_external_ref', 'externalRef contains unsupported characters')
  if (!SAFE_EVENT_TYPE.test(eventType)) throw new DomainError(400, 'invalid_event_type', 'eventType contains unsupported characters')
  if (input.credentialType !== 'session' && input.credentialType !== 'api_key') {
    throw new DomainError(400, 'invalid_credential', 'credentialType must be session or api_key')
  }
  requiredText(input.credentialId, 'credentialId')
  if (!SAFE_IDEMPOTENCY.test(input.idempotencyKey ?? '')) {
    throw new DomainError(400, 'invalid_idempotency_key', 'idempotencyKey must contain 8-200 visible ASCII characters')
  }
  if (input.sequence != null && (!Number.isSafeInteger(input.sequence) || input.sequence < 0)) {
    throw new DomainError(400, 'invalid_sequence', 'sequence must be a non-negative safe integer')
  }

  return {
    ...input,
    ownerId,
    externalRef,
    eventType,
    commitment: digest(input.commitment, 'commitment'),
    manifestHash: digest(input.manifestHash, 'manifestHash'),
    requestHash: digest(input.requestHash, 'requestHash'),
    occurredAt: timestamp(input.occurredAt, 'occurredAt'),
    deliveryId: input.deliveryId ? requiredText(input.deliveryId, 'deliveryId') : null,
    caseId: input.caseId ? requiredText(input.caseId, 'caseId') : null,
    sourceId: input.sourceId ? requiredText(input.sourceId, 'sourceId') : null,
    sourceKeyId: input.sourceKeyId ? requiredText(input.sourceKeyId, 'sourceKeyId') : null,
    sourceSignature: input.sourceSignature ? requiredText(input.sourceSignature, 'sourceSignature', 1024) : null,
    correctsEventId: input.correctsEventId ? requiredText(input.correctsEventId, 'correctsEventId') : null,
  }
}

export function logicalChainName(ownerId: string, track: EvidenceTrack, externalRef: string): string {
  return canonicalize({ external_ref: externalRef, owner_id: ownerId, track })
}

export async function computeEventProof(input: {
  chainId: string
  position: number
  receivedAt: string
  commitment: string
  previousProof: string | null
}): Promise<string> {
  return sha256Bytes(`OD1|EVENT|${input.chainId}|${input.position}|${input.receivedAt}|${input.commitment}|${input.previousProof ?? ''}`)
}

function decodeStoredResult(row: IdempotencyRow): ChainAppendResult {
  if (row.status !== 'completed' || !row.response_json) {
    throw new DomainError(409, 'idempotency_in_progress', 'The idempotent request is not complete; retry later')
  }
  try {
    return JSON.parse(row.response_json) as ChainAppendResult
  } catch {
    throw new DomainError(500, 'corrupt_idempotency_record', 'Stored idempotency response is invalid')
  }
}

function computeSequenceStatus(source: SourceState, sequence: number | null | undefined): string | null {
  if (sequence == null) return null
  if (source.last_sequence == null) return 'first'
  if (sequence > source.last_sequence) return sequence === source.last_sequence + 1 ? 'in_order' : 'gap'
  if (source.out_of_order_policy === 'strict' || source.out_of_order_policy === 'reject') {
    throw new DomainError(409, 'out_of_order_sequence', `sequence must be greater than ${source.last_sequence}`)
  }
  return 'out_of_order'
}

export class SerializedChainService {
  constructor(
    private readonly repository: ChainRepository,
    private readonly signer: ReceiptSigner,
    private readonly now: () => Date = () => new Date(),
    private readonly environment: 'dev' | 'prod' = 'dev',
  ) {}

  async append(rawInput: ChainAppendInput): Promise<ChainAppendResult> {
    const input = normalizeChainAppendInput(rawInput)
    const replay = await this.repository.findIdempotency(input.credentialType, input.credentialId, input.idempotencyKey)
    if (replay) {
      if (replay.request_hash !== input.requestHash) {
        throw new DomainError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body')
      }
      return decodeStoredResult(replay)
    }

    const existing = await this.repository.findChain(input.ownerId, input.track, input.externalRef)
    const chain: ChainRow = existing ?? { id: crypto.randomUUID(), previous_proof: null, next_position: 1 }
    const receivedAt = this.now().toISOString()
    const position = chain.next_position
    const previousProof = chain.previous_proof

    if (input.correctsEventId) {
      const corrected = await this.repository.findCorrectionTarget(input.correctsEventId, input.ownerId)
      if (!corrected || corrected.chain_id !== chain.id) {
        throw new DomainError(400, 'invalid_correction_target', 'A correction must reference an event in the same chain')
      }
    }

    let sequenceStatus: string | null = null
    if (input.sourceId) {
      const source = await this.repository.findSource(input.sourceId, input.ownerId)
      if (!source || source.status !== 'active' || source.external_ref !== input.externalRef) {
        throw new DomainError(404, 'source_not_found', 'Active source was not found for this chain')
      }
      sequenceStatus = computeSequenceStatus(source, input.sequence)
    }

    const proof = await computeEventProof({
      chainId: chain.id,
      position,
      receivedAt,
      commitment: input.commitment,
      previousProof,
    })
    const eventId = crypto.randomUUID()
    const receipt: ReceiptPayload = {
      version: 'OD-RECEIPT-1',
      environment: this.environment,
      event_id: eventId,
      chain_id: chain.id,
      external_ref: input.externalRef,
      track: input.track,
      event_type: input.eventType,
      position,
      commitment: input.commitment,
      manifest_hash: input.manifestHash,
      proof,
      previous_proof: previousProof,
      occurred_at: input.occurredAt,
      received_at: receivedAt,
      delivery_id: input.deliveryId ?? null,
      sequence: input.sequence ?? null,
      sequence_status: sequenceStatus,
      anchor_status: 'pending_anchor',
      signing_key_id: this.signer.keyId,
      signature_algorithm: RECEIPT_SIGNATURE_ALGORITHM,
    }
    const signedReceipt = await signReceiptPayload(receipt, this.signer)
    const receiptJson = signedReceipt.receipt_json
    const receiptPayloadHash = await sha256Bytes(receiptJson)
    const result: ChainAppendResult = {
      event_id: eventId,
      chain_id: chain.id,
      position,
      proof,
      previous_proof: previousProof,
      anchor_status: 'pending_anchor',
      receipt,
      receipt_json: receiptJson,
      signature: signedReceipt.signature,
      signing_key_id: signedReceipt.signing_key_id,
      signature_algorithm: signedReceipt.signature_algorithm,
      signed_receipt: signedReceipt,
    }
    const metadataJson = input.metadata == null ? null : canonicalize(input.metadata)
    const persisted: PersistedAppend = {
      input,
      chain,
      isNewChain: !existing,
      eventId,
      receivedAt,
      previousProof,
      position,
      proof,
      sequenceStatus,
      metadataJson,
      receiptPayloadHash,
      result,
    }
    try {
      await this.repository.commitAppend(persisted)
    } catch (error) {
      // D1's credential/idempotency unique key is global while Durable Objects
      // serialize per logical chain. If two chains race with the same key, the
      // losing atomic batch observes and returns the committed winner.
      const winner = await this.repository.findIdempotency(input.credentialType, input.credentialId, input.idempotencyKey)
      if (!winner) throw error
      if (winner.request_hash !== input.requestHash) {
        throw new DomainError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body')
      }
      return decodeStoredResult(winner)
    }
    return result
  }
}

export class D1ChainRepository implements ChainRepository {
  constructor(private readonly database: D1Database) {}

  async findIdempotency(credentialType: CredentialType, credentialId: string, key: string): Promise<IdempotencyRow | null> {
    return this.database.prepare(
      'SELECT request_hash, response_json, status FROM idempotency_records WHERE credential_type = ? AND credential_id = ? AND idempotency_key = ? LIMIT 1',
    ).bind(credentialType, credentialId, key).first<IdempotencyRow>()
  }

  async findChain(ownerId: string, track: EvidenceTrack, externalRef: string): Promise<ChainRow | null> {
    return this.database.prepare(
      'SELECT id, previous_proof, next_position FROM chains WHERE owner_id = ? AND track = ? AND external_ref = ? LIMIT 1',
    ).bind(ownerId, track, externalRef).first<ChainRow>()
  }

  async findCorrectionTarget(eventId: string, ownerId: string): Promise<{ id: string; chain_id: string } | null> {
    return this.database.prepare(
      'SELECT id, chain_id FROM events WHERE id = ? AND owner_id = ? LIMIT 1',
    ).bind(eventId, ownerId).first<{ id: string; chain_id: string }>()
  }

  async findSource(sourceId: string, ownerId: string): Promise<SourceState | null> {
    return this.database.prepare(
      'SELECT id, external_ref, owner_id, status, out_of_order_policy, last_sequence FROM sources WHERE id = ? AND owner_id = ? LIMIT 1',
    ).bind(sourceId, ownerId).first<SourceState>()
  }

  async commitAppend(append: PersistedAppend): Promise<void> {
    const { input, chain, result } = append
    const statements: D1PreparedStatement[] = []
    if (append.isNewChain) {
      statements.push(this.database.prepare(
        'INSERT INTO chains (id, owner_id, track, external_ref, previous_proof, next_position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(chain.id, input.ownerId, input.track, input.externalRef, append.proof, append.position + 1, append.receivedAt))
    } else {
      statements.push(this.database.prepare(
        'UPDATE chains SET previous_proof = ?, next_position = ? WHERE id = ?',
      ).bind(append.proof, append.position + 1, chain.id))
    }

    statements.push(this.database.prepare(`
      INSERT INTO events (
        id, chain_id, owner_id, position, commitment, manifest_hash, previous_proof, proof, created_at,
        track, external_ref, case_id, event_type, action, source_id, delivery_id, occurred_at, received_at,
        sequence, idempotency_key, credential_type, credential_id, request_hash, source_key_id,
        source_signature, corrects_event_id, sequence_status, metadata_json, anchor_status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_anchor', ?)
    `).bind(
      append.eventId,
      chain.id,
      input.ownerId,
      append.position,
      input.commitment,
      input.manifestHash,
      append.previousProof,
      append.proof,
      append.receivedAt,
      input.track,
      input.externalRef,
      input.caseId ?? null,
      input.eventType,
      input.track === 'M' ? input.eventType : null,
      input.sourceId ?? null,
      input.deliveryId ?? null,
      input.occurredAt,
      append.receivedAt,
      input.sequence ?? null,
      input.idempotencyKey,
      input.credentialType,
      input.credentialId,
      input.requestHash,
      input.sourceKeyId ?? null,
      input.sourceSignature ?? null,
      input.correctsEventId ?? null,
      append.sequenceStatus,
      append.metadataJson,
      append.receivedAt,
    ))
    statements.push(this.database.prepare(`
      UPDATE chains SET head_event_id = ?, last_received_at = ?, updated_at = ? WHERE id = ?
    `).bind(append.eventId, append.receivedAt, append.receivedAt, chain.id))
    statements.push(this.database.prepare(
      'INSERT INTO receipts (id, event_id, receipt_json, signature, signing_key_id, signature_algorithm, receipt_version, payload_hash, environment, anchor_status, issued_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), append.eventId, result.receipt_json, result.signature, result.signing_key_id, result.signature_algorithm, '1', append.receiptPayloadHash, result.receipt.environment, 'pending_anchor', append.receivedAt, append.receivedAt, append.receivedAt))
    statements.push(this.database.prepare(`
      INSERT INTO idempotency_records (
        id, owner_id, credential_type, credential_id, idempotency_key, request_hash, status,
        response_status, response_json, event_id, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'completed', 201, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      input.ownerId,
      input.credentialType,
      input.credentialId,
      input.idempotencyKey,
      input.requestHash,
      JSON.stringify(result),
      append.eventId,
      new Date(new Date(append.receivedAt).valueOf() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      append.receivedAt,
      append.receivedAt,
    ))
    if (input.caseId) {
      statements.push(this.database.prepare(
        'UPDATE cases SET chain_id = COALESCE(chain_id, ?), updated_at = ? WHERE id = ? AND owner_id = ?',
      ).bind(chain.id, append.receivedAt, input.caseId, input.ownerId))
    }
    if (input.sourceId) {
      statements.push(this.database.prepare(`
        UPDATE sources SET
          chain_id = COALESCE(chain_id, ?),
          last_sequence = CASE WHEN ? IS NULL THEN last_sequence WHEN last_sequence IS NULL OR ? > last_sequence THEN ? ELSE last_sequence END,
          last_received_at = ?,
          updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).bind(chain.id, input.sequence ?? null, input.sequence ?? null, input.sequence ?? null, append.receivedAt, append.receivedAt, input.sourceId, input.ownerId))
    }
    await this.database.batch(statements)
  }
}

export interface DurableObjectIdLike {}
export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike
  get(id: DurableObjectIdLike): DurableObjectStubLike
}

export interface ChainAppender {
  append(input: ChainAppendInput): Promise<ChainAppendResult>
}

export function durableObjectChainAppender(namespace: DurableObjectNamespaceLike): ChainAppender {
  return {
    async append(input) {
      const id = namespace.idFromName(logicalChainName(input.ownerId, input.track, input.externalRef))
      const response = await namespace.get(id).fetch('https://chain.internal/append', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await response.json() as ChainAppendResult | { error?: string; code?: string }
      if (!response.ok) {
        const failure = body as { error?: string; code?: string }
        throw new DomainError(response.status, failure.code ?? 'chain_append_failed', failure.error ?? 'Chain append failed')
      }
      return body as ChainAppendResult
    },
  }
}

export interface ChainDurableObjectDependencies<Environment> {
  database(environment: Environment): D1Database
  signer(environment: Environment): ReceiptSigner | Promise<ReceiptSigner>
  environment(environment: Environment): 'dev' | 'prod'
  now?: () => Date
}

type DurableObjectStateLike = {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

/**
 * Factory used by the Worker entry point to export its bound DO class. The
 * signer is injected so production can load a versioned Ed25519 key while tests
 * can use a deterministic signer.
 */
export function createChainDurableObject<Environment>(dependencies: ChainDurableObjectDependencies<Environment>) {
  return class ChainDurableObject {
    private signer!: ReceiptSigner
    private queue: Promise<void> = Promise.resolve()

    constructor(
      state: DurableObjectStateLike,
      private readonly environment: Environment,
    ) {
      state.blockConcurrencyWhile(async () => {
        this.signer = await dependencies.signer(environment)
      })
    }

    fetch(request: Request): Promise<Response> {
      let release!: () => void
      const previous = this.queue
      this.queue = new Promise<void>((resolve) => { release = resolve })
      return previous.then(async () => {
        try {
          const url = new URL(request.url)
          if (request.method !== 'POST' || url.pathname !== '/append') {
            return Response.json({ error: 'Not found', code: 'not_found' }, { status: 404 })
          }
          const input = await request.json() as ChainAppendInput
          const service = new SerializedChainService(
            new D1ChainRepository(dependencies.database(this.environment)),
            this.signer,
            dependencies.now,
            dependencies.environment(this.environment),
          )
          return Response.json(await service.append(input), { status: 201 })
        } catch (error) {
          if (error instanceof DomainError) {
            return Response.json({ error: error.message, code: error.code }, { status: error.status })
          }
          console.error(error)
          return Response.json({ error: 'Chain append failed', code: 'internal_error' }, { status: 500 })
        } finally {
          release()
        }
      })
    }
  }
}
