import { Hono } from 'hono'
import { canonicalSha256, canonicalize, sha256Bytes } from './canonical'
import { DomainError, type ChainAppendResult, type ChainAppender } from './chain-do'

export type MachineScope = 'source:write' | 'record:write' | 'record:batch' | 'receipt:read' | 'usage:read'

export interface MachineCredential {
  keyId: string
  ownerId: string
  scopes: MachineScope[]
  environment: 'dev' | 'prod'
}

export interface TrackMOwnerActor {
  userId: string
  role: 'supplier' | 'verifier'
}

export interface MachinePlan {
  active: boolean
  writesPerMinute: number
  recordsPerWrite: number
}

export interface MachinePlanProvider {
  getPlan(ownerId: string): Promise<MachinePlan | null>
}

export interface MachineSource {
  id: string
  owner_id: string
  external_ref: string
  label: string
  source_type: string | null
  out_of_order_policy: string
  last_sequence: number | null
  status: string
  metadata_json: string | null
  chain_id: string | null
  created_at: string
  updated_at: string
}

export interface CreateSourceInput {
  source_id: string
  label: string
  source_type?: string | null
  out_of_order_policy?: 'strict' | 'accept_and_flag'
  metadata?: unknown
  idempotency_key?: string
}

export interface MachineRecordInput {
  source_id: string
  delivery_id?: string | null
  action: string
  occurred_at: string
  sequence?: number | null
  commitment?: string
  content_hash?: string
  record_salt?: string
  json?: unknown
  text?: string
  content_base64?: string
  content_name?: string | null
  content_type?: string | null
  params?: unknown
  metadata?: unknown
  source_key_id?: string | null
  source_signature?: string | null
  idempotency_key?: string
}

export interface MachineUsage {
  period_start: string
  period_end: string
  records_observed: number
  current_minute_start: string
  writes_current_minute: number
  writes_per_minute: number
  records_per_write: number
}

const SOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const ACTION = /^[A-Z0-9][A-Z0-9_.:-]{0,95}$/
const DIGEST = /^[a-f0-9]{64}$/
const ALLOWED_SCOPES = new Set<MachineScope>(['source:write', 'record:write', 'record:batch', 'receipt:read', 'usage:read'])
const FORBIDDEN_INPUT_KEYS = new Set(['encrypted_capsule', 'passcode', 'file', 'file_path', 'local_path', 'url', 'remote_url'])
const MAX_EPHEMERAL_CONTENT_BYTES = 10 * 1024 * 1024

function normalizedDigest(value: string, field: string): string {
  const digest = value?.toLowerCase().replace(/^sha256:/, '').replace(/^0x/, '')
  if (!DIGEST.test(digest)) throw new DomainError(400, 'invalid_digest', `${field} must be a SHA-256 hex digest`)
  return digest
}

function hexBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2)
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return result
}

function required(value: unknown, field: string, maximum = 128): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum) {
    throw new DomainError(400, 'invalid_request', `${field} is required and must be at most ${maximum} characters`)
  }
  return value.trim()
}

function assertNoRemoteOrRetainedInput(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_INPUT_KEYS.has(key.toLowerCase())) {
      throw new DomainError(400, 'unsupported_input', `${key} is not accepted; hash files locally and never send a path, URL, passcode, or capsule`)
    }
    if (child && typeof child === 'object') assertNoRemoteOrRetainedInput(child)
  }
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined))
}

function decodeEphemeralBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_EPHEMERAL_CONTENT_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new DomainError(400, 'invalid_content_base64', 'content_base64 must be standard padded base64 up to 10 MiB decoded')
  }
  let binary: string
  try { binary = atob(value) }
  catch { throw new DomainError(400, 'invalid_content_base64', 'content_base64 is invalid') }
  if (binary.length > MAX_EPHEMERAL_CONTENT_BYTES) throw new DomainError(413, 'content_too_large', 'Ephemeral file content is limited to 10 MiB per record')
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export interface MachineEvidenceMaterial {
  contentHash: string | null
  contentKind: 'commitment' | 'hash' | 'json' | 'text' | 'file'
  contentLength: number | null
  commitment: string
}

export async function deriveMachineEvidence(input: Pick<MachineRecordInput, 'commitment' | 'content_hash' | 'record_salt' | 'json' | 'text' | 'content_base64'>): Promise<MachineEvidenceMaterial> {
  const hasCommitment = input.commitment != null
  const contentOptions = Number(input.content_hash != null) + Number(input.json !== undefined) + Number(input.text !== undefined) + Number(input.content_base64 !== undefined)
  if (hasCommitment) {
    if (contentOptions > 0 || input.record_salt != null) {
      throw new DomainError(400, 'ambiguous_content', 'Send commitment alone, or send one content form with record_salt')
    }
    return { contentHash: null, contentKind: 'commitment', contentLength: null, commitment: normalizedDigest(input.commitment!, 'commitment') }
  }
  if (contentOptions !== 1) throw new DomainError(400, 'invalid_content', 'Exactly one of content_hash, json, text, or content_base64 is required when commitment is absent')
  const salt = normalizedDigest(input.record_salt ?? '', 'record_salt')
  let contentHash: string
  let contentKind: MachineEvidenceMaterial['contentKind']
  let contentLength: number | null
  if (input.content_hash != null) {
    contentHash = normalizedDigest(input.content_hash, 'content_hash')
    contentKind = 'hash'
    contentLength = null
  } else if (input.json !== undefined) {
    const canonical = canonicalize(input.json)
    contentHash = await sha256Bytes(canonical)
    contentKind = 'json'
    contentLength = new TextEncoder().encode(canonical).byteLength
  } else if (input.text !== undefined) {
    const bytes = new TextEncoder().encode(input.text)
    contentHash = await sha256Bytes(bytes)
    contentKind = 'text'
    contentLength = bytes.byteLength
  } else {
    const bytes = decodeEphemeralBase64(input.content_base64!)
    contentHash = await sha256Bytes(bytes)
    contentKind = 'file'
    contentLength = bytes.byteLength
  }
  // C = SHA-256(UTF8("OD1|CONTENT|") || raw 32-byte salt || raw 32-byte H).
  // H and salt are deliberately discarded after this transient calculation.
  const domain = new TextEncoder().encode('OD1|CONTENT|')
  const bytes = new Uint8Array(domain.length + 64)
  bytes.set(domain, 0)
  bytes.set(hexBytes(salt), domain.length)
  bytes.set(hexBytes(contentHash), domain.length + 32)
  return { contentHash, contentKind, contentLength, commitment: await sha256Bytes(bytes) }
}

export async function deriveMachineCommitment(input: Pick<MachineRecordInput, 'commitment' | 'content_hash' | 'record_salt' | 'json' | 'text' | 'content_base64'>): Promise<string> {
  return (await deriveMachineEvidence(input)).commitment
}

export async function machineRequestHash(input: MachineRecordInput): Promise<string> {
  assertNoRemoteOrRetainedInput(input)
  return canonicalSha256(input)
}

export function machineManifest(input: MachineRecordInput, material: MachineEvidenceMaterial, supplierUsername?: string): Record<string, unknown> {
  return withoutUndefined({
    version: 'OD-MANIFEST-1',
    supplier_username: supplierUsername,
    track: 'M',
    source_id: input.source_id,
    delivery_id: input.delivery_id ?? null,
    action: input.action,
    occurred_at: new Date(input.occurred_at).toISOString(),
    sequence: input.sequence ?? null,
    content_kind: material.contentKind,
    content_length: material.contentLength,
    content_name: input.content_name ?? null,
    content_type: input.content_type ?? null,
    content_hash: material.contentHash,
    commitment: material.commitment,
    params: input.params ?? null,
    metadata: input.metadata ?? null,
    source_key_id: input.source_key_id ?? null,
    source_signature: input.source_signature ?? null,
  })
}

export async function machineManifestHash(input: MachineRecordInput, commitment: string): Promise<string> {
  return canonicalSha256(machineManifest(input, { contentHash: null, contentKind: 'commitment', contentLength: null, commitment }))
}

function monthWindow(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { start: start.toISOString(), end: end.toISOString() }
}

function requireScope(credential: MachineCredential, scope: MachineScope): void {
  if (!credential.scopes.includes(scope)) throw new DomainError(403, 'insufficient_scope', `API key requires ${scope}`)
}

function parseJsonArray(value: string): MachineScope[] {
  try {
    const scopes = JSON.parse(value) as unknown
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || !ALLOWED_SCOPES.has(scope as MachineScope))) throw new Error()
    return scopes as MachineScope[]
  } catch {
    throw new DomainError(500, 'invalid_api_key_scope', 'Stored API key scopes are invalid')
  }
}

function apiKeySecret(environment: string): string {
  const random = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of random) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return `od_sk_${environment}_${encoded}`
}

export class TrackMApiKeyService {
  constructor(private readonly database: D1Database, private readonly environment: 'dev' | 'prod', private readonly now: () => Date = () => new Date()) {}

  async issue(ownerId: string, labelValue: string, scopesValue: readonly MachineScope[], expiresAt?: string | null): Promise<{ id: string; key: string; prefix: string; scopes: MachineScope[] }> {
    const label = required(labelValue, 'label', 100)
    const scopes = [...new Set(scopesValue)]
    if (scopes.length === 0 || scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
      throw new DomainError(400, 'invalid_scope', 'At least one supported machine scope is required')
    }
    const key = apiKeySecret(this.environment)
    const keyHash = await sha256Bytes(key)
    const prefix = key.slice(0, 18)
    const id = crypto.randomUUID()
    const createdAt = this.now().toISOString()
    let normalizedExpiry: string | null = null
    if (expiresAt) {
      const parsed = new Date(expiresAt)
      if (!Number.isFinite(parsed.valueOf()) || parsed <= this.now()) throw new DomainError(400, 'invalid_expiry', 'expires_at must be in the future')
      normalizedExpiry = parsed.toISOString()
    }
    const statements: D1PreparedStatement[] = [this.database.prepare(`
      INSERT INTO api_keys (
        id, user_id, key_hash, key_prefix, label, scopes_json, machine_only, is_active,
        environment, expires_at, revoked_at, last_used_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, NULL, NULL, ?)
    `).bind(id, ownerId, keyHash, prefix, label, canonicalize(scopes), this.environment, normalizedExpiry, createdAt)]
    for (const scope of scopes) {
      statements.push(this.database.prepare(
        'INSERT INTO api_key_scopes (api_key_id, scope, created_at) VALUES (?, ?, ?)',
      ).bind(id, scope, createdAt))
    }
    await this.database.batch(statements)
    return { id, key, prefix, scopes }
  }

  async revoke(ownerId: string, keyId: string): Promise<void> {
    const result = await this.database.prepare(
      'UPDATE api_keys SET is_active = 0, revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    ).bind(this.now().toISOString(), this.now().toISOString(), keyId, ownerId).run()
    if (!result.meta.changes) throw new DomainError(404, 'api_key_not_found', 'Active API key not found')
  }

  async rotate(ownerId: string, keyId: string): Promise<{ id: string; key: string; prefix: string; scopes: MachineScope[] }> {
    const current = await this.database.prepare(`
      SELECT label, scopes_json, expires_at FROM api_keys
      WHERE id = ? AND user_id = ? AND is_active = 1 AND revoked_at IS NULL LIMIT 1
    `).bind(keyId, ownerId).first<{ label: string; scopes_json: string; expires_at: string | null }>()
    if (!current) throw new DomainError(404, 'api_key_not_found', 'Active API key not found')
    const scopes = parseJsonArray(current.scopes_json)
    const key = apiKeySecret(this.environment)
    const keyHash = await sha256Bytes(key)
    const prefix = key.slice(0, 18)
    const id = crypto.randomUUID()
    const createdAt = this.now().toISOString()
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        INSERT INTO api_keys (
          id, user_id, key_hash, key_prefix, label, scopes_json, machine_only,
          is_active, environment, expires_at, revoked_at, last_used_at,
          rotated_from_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, NULL, NULL, ?, ?, ?)
      `).bind(
        id,
        ownerId,
        keyHash,
        prefix,
        current.label,
        canonicalize(scopes),
        this.environment,
        current.expires_at,
        keyId,
        createdAt,
        createdAt,
      ),
      this.database.prepare(`
        UPDATE api_keys SET is_active = 0, revoked_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND is_active = 1 AND revoked_at IS NULL
      `).bind(createdAt, createdAt, keyId, ownerId),
    ]
    for (const scope of scopes) {
      statements.push(this.database.prepare(
        'INSERT INTO api_key_scopes (api_key_id, scope, created_at) VALUES (?, ?, ?)',
      ).bind(id, scope, createdAt))
    }
    await this.database.batch(statements)
    return { id, key, prefix, scopes }
  }

  async list(ownerId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.database.prepare(`
      SELECT id, key_prefix, label, scopes_json, environment, last_used_at, expires_at,
             revoked_at, is_active, created_at
      FROM api_keys WHERE user_id = ? AND environment = ? ORDER BY created_at DESC
    `).bind(ownerId, this.environment).all<Record<string, unknown>>()
    return rows.results.map((row) => {
      const { scopes_json: scopesJson, ...safe } = row
      return { ...safe, scopes: typeof scopesJson === 'string' ? parseJsonArray(scopesJson) : [] }
    })
  }
}

export async function authenticateMachineApiKey(database: D1Database, authorization: string | undefined, environment: 'dev' | 'prod', now = new Date()): Promise<MachineCredential> {
  if (!authorization?.startsWith('Bearer ')) throw new DomainError(401, 'invalid_api_key', 'Bearer API key required')
  const plaintext = authorization.slice('Bearer '.length).trim()
  if (!plaintext.startsWith(`od_sk_${environment}_`) || plaintext.length < 32) throw new DomainError(401, 'invalid_api_key', 'Invalid API key')
  const keyHash = await sha256Bytes(plaintext)
  const row = await database.prepare(`
    SELECT k.id, k.user_id, k.scopes_json, k.environment, k.expires_at,
           k.revoked_at, k.is_active, u.is_active AS user_active, u.role
    FROM api_keys k JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ? AND k.environment = ? LIMIT 1
  `).bind(keyHash, environment).first<{
    id: string
    user_id: string
    scopes_json: string
    environment: string
    expires_at: string | null
    revoked_at: string | null
    is_active: number
    user_active: number
    role: string
  }>()
  if (!row || !row.is_active || !row.user_active || row.revoked_at || row.role !== 'supplier' || (row.expires_at && new Date(row.expires_at) <= now)) {
    throw new DomainError(401, 'invalid_api_key', 'Invalid API key')
  }
  await database.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now.toISOString(), row.id).run()
  return { keyId: row.id, ownerId: row.user_id, scopes: parseJsonArray(row.scopes_json), environment: row.environment as 'dev' | 'prod' }
}

export class TrackMService {
  constructor(
    private readonly database: D1Database,
    private readonly appender: ChainAppender,
    private readonly plans: MachinePlanProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async plan(credential: MachineCredential): Promise<MachinePlan> {
    const plan = await this.plans.getPlan(credential.ownerId)
    if (!plan?.active) throw new DomainError(402, 'active_plan_required', 'An active Track M writer plan is required')
    return plan
  }

  async createSource(credential: MachineCredential, input: CreateSourceInput): Promise<MachineSource> {
    requireScope(credential, 'source:write')
    await this.plan(credential)
    assertNoRemoteOrRetainedInput(input)
    if (!input.idempotency_key) throw new DomainError(400, 'idempotency_required', 'Idempotency-Key is required')
    const requestHash = await canonicalSha256(input)
    const credentialType = credential.keyId.startsWith('session:') ? 'session' : 'api_key'
    const replay = await this.database.prepare(`
      SELECT request_hash, response_json, status FROM idempotency_records
      WHERE credential_type = ? AND credential_id = ? AND idempotency_key = ? LIMIT 1
    `).bind(credentialType, credential.keyId, input.idempotency_key).first<{ request_hash: string; response_json: string | null; status: string }>()
    if (replay) {
      if (replay.request_hash !== requestHash) throw new DomainError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body')
      if (replay.status !== 'completed' || !replay.response_json) throw new DomainError(409, 'idempotency_in_progress', 'Request is still being processed')
      return JSON.parse(replay.response_json) as MachineSource
    }
    const externalRef = required(input.source_id, 'source_id')
    if (!SOURCE_REF.test(externalRef)) throw new DomainError(400, 'invalid_source_id', 'source_id contains unsupported characters')
    const id = crypto.randomUUID()
    const createdAt = this.now().toISOString()
    const policy = input.out_of_order_policy ?? 'accept_and_flag'
    if (policy !== 'strict' && policy !== 'accept_and_flag') throw new DomainError(400, 'invalid_sequence_policy', 'out_of_order_policy must be strict or accept_and_flag')
    const label = required(input.label, 'label', 100)
    const sourceType = input.source_type?.trim() || null
    const metadataJson = input.metadata == null ? null : canonicalize(input.metadata)
    const organization = await this.database.prepare('SELECT id FROM organizations WHERE user_id = ? LIMIT 1').bind(credential.ownerId).first<{ id: string }>()
    const source: MachineSource = {
      id,
      owner_id: credential.ownerId,
      external_ref: externalRef,
      label,
      source_type: sourceType,
      out_of_order_policy: policy,
      last_sequence: null,
      status: 'active',
      metadata_json: metadataJson,
      chain_id: null,
      created_at: createdAt,
      updated_at: createdAt,
    }
    try {
      await this.database.batch([this.database.prepare(`
        INSERT INTO sources (
          id, owner_id, organization_id, chain_id, external_ref, label, source_type,
          out_of_order_policy, last_sequence, status, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'active', ?, ?, ?)
      `).bind(
        id,
        credential.ownerId,
        organization?.id ?? null,
        externalRef,
        label,
        sourceType,
        policy,
        metadataJson,
        createdAt,
        createdAt,
      ), this.database.prepare(`
        INSERT INTO idempotency_records (
          id, owner_id, credential_type, credential_id, idempotency_key, request_hash,
          status, response_status, response_json, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'completed', 201, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), credential.ownerId, credentialType, credential.keyId,
        input.idempotency_key, requestHash, canonicalize(source),
        new Date(this.now().valueOf() + 90 * 24 * 60 * 60 * 1000).toISOString(), createdAt, createdAt,
      )])
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        const winner = await this.database.prepare(`
          SELECT request_hash, response_json, status FROM idempotency_records
          WHERE credential_type = ? AND credential_id = ? AND idempotency_key = ? LIMIT 1
        `).bind(credentialType, credential.keyId, input.idempotency_key).first<{ request_hash: string; response_json: string | null; status: string }>()
        if (winner?.request_hash === requestHash && winner.status === 'completed' && winner.response_json) {
          return JSON.parse(winner.response_json) as MachineSource
        }
        throw new DomainError(409, 'source_conflict', 'source_id already exists')
      }
      throw error
    }
    return source
  }

  async listSources(credential: MachineCredential): Promise<MachineSource[]> {
    requireScope(credential, 'source:write')
    const rows = await this.database.prepare(`
      SELECT id, owner_id, external_ref, label, source_type, out_of_order_policy,
             last_sequence, status, metadata_json, chain_id, created_at, updated_at
      FROM sources WHERE owner_id = ? ORDER BY created_at DESC
    `).bind(credential.ownerId).all<MachineSource>()
    return rows.results
  }

  async getSource(credential: MachineCredential, externalRef: string): Promise<MachineSource> {
    requireScope(credential, 'source:write')
    const source = await this.database.prepare(`
      SELECT id, owner_id, external_ref, label, source_type, out_of_order_policy,
             last_sequence, status, metadata_json, chain_id, created_at, updated_at
      FROM sources WHERE owner_id = ? AND external_ref = ? LIMIT 1
    `).bind(credential.ownerId, externalRef).first<MachineSource>()
    if (!source) throw new DomainError(404, 'source_not_found', 'Source not found')
    return source
  }

  async usage(credential: MachineCredential): Promise<MachineUsage> {
    requireScope(credential, 'usage:read')
    const plan = await this.plans.getPlan(credential.ownerId)
    const period = monthWindow(this.now())
    const count = await this.database.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE owner_id = ? AND track = 'M' AND received_at >= ? AND received_at < ?
    `).bind(credential.ownerId, period.start, period.end).first<{ count: number }>()
    const used = Number(count?.count ?? 0)
    const minuteStart = new Date(Math.floor(this.now().valueOf() / 60_000) * 60_000).toISOString()
    const rate = await this.database.prepare(`
      SELECT request_count FROM rate_limit_counters
      WHERE credential_type = 'api_key' AND credential_id = ?
        AND route_key = 'track_m:write' AND window_start = ? AND window_seconds = 60
      LIMIT 1
    `).bind(`owner:${credential.ownerId}`, minuteStart).first<{ request_count: number }>()
    return {
      period_start: period.start,
      period_end: period.end,
      records_observed: used,
      current_minute_start: minuteStart,
      writes_current_minute: Number(rate?.request_count ?? 0),
      writes_per_minute: plan?.active ? plan.writesPerMinute : 0,
      records_per_write: plan?.active ? plan.recordsPerWrite : 0,
    }
  }

  private async consumeWrite(credential: MachineCredential, recordCount: number, plan: MachinePlan): Promise<void> {
    if (!Number.isSafeInteger(plan.writesPerMinute) || plan.writesPerMinute <= 0) {
      throw new DomainError(402, 'write_rate_unavailable', 'The active plan does not permit machine writes')
    }
    if (recordCount > plan.recordsPerWrite) {
      throw new DomainError(413, 'records_per_write_exceeded', `Plan permits at most ${plan.recordsPerWrite} records per write`)
    }
    const bucket = new Date(Math.floor(this.now().valueOf() / 60_000) * 60_000).toISOString()
    const result = await this.database.prepare(`
      INSERT INTO rate_limit_counters (
        owner_id, credential_type, credential_id, route_key, window_start,
        window_seconds, request_count, record_count, updated_at
      ) VALUES (?, 'api_key', ?, 'track_m:write', ?, 60, 1, ?, ?)
      ON CONFLICT(credential_type, credential_id, route_key, window_start, window_seconds)
      DO UPDATE SET
        request_count = rate_limit_counters.request_count + 1,
        record_count = rate_limit_counters.record_count + excluded.record_count,
        updated_at = excluded.updated_at
      WHERE rate_limit_counters.request_count < ?
    `).bind(credential.ownerId, `owner:${credential.ownerId}`, bucket, recordCount, this.now().toISOString(), plan.writesPerMinute).run()
    if (!result.meta.changes) throw new DomainError(429, 'write_rate_exceeded', `Plan permits ${plan.writesPerMinute} writes per minute`)
  }

  private async replay(input: MachineRecordInput, credential: MachineCredential, requestHash: string): Promise<ChainAppendResult | null> {
    const row = await this.database.prepare(`
      SELECT request_hash, response_json, status FROM idempotency_records
      WHERE credential_type = 'api_key' AND credential_id = ? AND idempotency_key = ? LIMIT 1
    `).bind(credential.keyId, input.idempotency_key).first<{ request_hash: string; response_json: string | null; status: string }>()
    if (!row) return null
    if (row.request_hash !== requestHash) throw new DomainError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body')
    if (row.status !== 'completed' || !row.response_json) throw new DomainError(409, 'idempotency_in_progress', 'Request is still being processed')
    return JSON.parse(row.response_json) as ChainAppendResult
  }

  async appendRecord(credential: MachineCredential, input: MachineRecordInput): Promise<ChainAppendResult> {
    return this.appendRecordInternal(credential, input, true)
  }

  private async appendRecordInternal(credential: MachineCredential, input: MachineRecordInput, countWrite: boolean, knownPlan?: MachinePlan): Promise<ChainAppendResult> {
    requireScope(credential, 'record:write')
    const plan = knownPlan ?? await this.plan(credential)
    assertNoRemoteOrRetainedInput(input)
    if (!input.idempotency_key) throw new DomainError(400, 'idempotency_required', 'Idempotency-Key is required')
    const requestHash = await machineRequestHash(input)
    const replay = await this.replay(input, credential, requestHash)
    if (replay) return replay
    if (countWrite) await this.consumeWrite(credential, 1, plan)

    const source = await this.getSource({ ...credential, scopes: [...credential.scopes, 'source:write'] }, required(input.source_id, 'source_id'))
    if (source.status !== 'active') throw new DomainError(409, 'source_inactive', 'Source is inactive')
    const action = required(input.action, 'action', 96).toUpperCase()
    if (!ACTION.test(action)) throw new DomainError(400, 'invalid_action', 'action contains unsupported characters')
    const occurred = new Date(input.occurred_at)
    if (!Number.isFinite(occurred.valueOf())) throw new DomainError(400, 'invalid_occurred_at', 'occurred_at must be an ISO-8601 timestamp')
    if (input.sequence != null && (!Number.isSafeInteger(input.sequence) || input.sequence < 0)) throw new DomainError(400, 'invalid_sequence', 'sequence must be a non-negative safe integer')
    const normalizedInput = { ...input, action, occurred_at: occurred.toISOString() }
    const material = await deriveMachineEvidence(normalizedInput)
    const identity = await this.database.prepare('SELECT username FROM users WHERE id = ? LIMIT 1').bind(credential.ownerId).first<{ username: string }>()
    if (!identity) throw new DomainError(401, 'invalid_api_key', 'Supplier account is unavailable')
    const manifest = machineManifest(normalizedInput, material, identity.username)
    const manifestHash = await canonicalSha256(manifest)
    const result = await this.appender.append({
      ownerId: credential.ownerId,
      track: 'M',
      externalRef: source.external_ref,
      eventType: action,
      commitment: material.commitment,
      manifestHash,
      occurredAt: occurred.toISOString(),
      sourceId: source.id,
      deliveryId: input.delivery_id ?? null,
      sequence: input.sequence ?? null,
      sourceKeyId: input.source_key_id ?? null,
      sourceSignature: input.source_signature ?? null,
      metadata: withoutUndefined({ params: input.params, metadata: input.metadata }),
      credentialType: 'api_key',
      credentialId: credential.keyId,
      idempotencyKey: input.idempotency_key,
      requestHash,
    })
    return {
      ...result,
      content_hash: material.contentHash,
      commitment: material.commitment,
      manifest,
      manifest_hash: manifestHash,
    } as ChainAppendResult
  }

  async appendBatch(credential: MachineCredential, inputs: MachineRecordInput[], batchKey: string): Promise<ChainAppendResult[]> {
    requireScope(credential, 'record:batch')
    const plan = await this.plan(credential)
    if (!Array.isArray(inputs) || inputs.length === 0) throw new DomainError(400, 'empty_batch', 'records must be a non-empty array')
    if (inputs.length > plan.recordsPerWrite) throw new DomainError(413, 'batch_too_large', `Plan permits at most ${plan.recordsPerWrite} records per write`)
    if (!/^[\x21-\x7e]{8,160}$/.test(batchKey)) throw new DomainError(400, 'invalid_idempotency_key', 'Batch Idempotency-Key must contain 8-160 visible ASCII characters')
    const recordCredential = { ...credential, scopes: [...credential.scopes, 'record:write' as const] }
    const derivedInputs = inputs.map((input, index) => ({ ...input, idempotency_key: `${batchKey}:${index}` }))
    const known = await Promise.all(derivedInputs.map(async (input) => this.replay(input, recordCredential, await machineRequestHash(input))))
    if (known.every((result) => result !== null)) return known as ChainAppendResult[]
    await this.consumeWrite(credential, inputs.length, plan)
    const results: ChainAppendResult[] = []
    // Sequential processing keeps usage checks conservative. Per-record derived
    // keys make retries safe even if a previous batch attempt stopped midway.
    for (let index = 0; index < inputs.length; index += 1) {
      results.push(await this.appendRecordInternal(recordCredential, derivedInputs[index], false, plan))
    }
    return results
  }

  async getReceipt(credential: MachineCredential, eventId: string): Promise<Record<string, unknown>> {
    requireScope(credential, 'receipt:read')
    const row = await this.database.prepare(`
      SELECT e.id AS event_id, e.chain_id, e.external_ref, e.position, e.event_type, e.occurred_at,
             e.received_at, e.commitment, e.manifest_hash, e.previous_proof, e.proof,
             e.anchor_status, e.anchor_batch_id, r.receipt_json, r.signature,
             r.signing_key_id, r.signature_algorithm
      FROM events e JOIN receipts r ON r.event_id = e.id
      WHERE e.id = ? AND e.owner_id = ? AND e.track = 'M' LIMIT 1
    `).bind(eventId, credential.ownerId).first<Record<string, unknown>>()
    if (!row) throw new DomainError(404, 'receipt_not_found', 'Receipt not found')
    return row
  }

  async sourceChain(credential: MachineCredential, sourceRef: string): Promise<Record<string, unknown>[]> {
    requireScope(credential, 'receipt:read')
    const rows = await this.database.prepare(`
      SELECT id, chain_id, position, action, delivery_id, occurred_at, received_at, sequence,
             sequence_status, commitment, manifest_hash, previous_proof, proof, anchor_status
      FROM events WHERE owner_id = ? AND track = 'M' AND external_ref = ? ORDER BY position ASC
    `).bind(credential.ownerId, sourceRef).all<Record<string, unknown>>()
    return rows.results
  }

  async deliveryEvents(credential: MachineCredential, deliveryId: string): Promise<Record<string, unknown>[]> {
    requireScope(credential, 'receipt:read')
    const rows = await this.database.prepare(`
      SELECT id, chain_id, external_ref AS source_id, position, action, delivery_id,
             occurred_at, received_at, sequence, sequence_status, commitment, manifest_hash,
             previous_proof, proof, anchor_status
      FROM events WHERE owner_id = ? AND track = 'M' AND delivery_id = ?
      ORDER BY occurred_at ASC, received_at ASC, id ASC
    `).bind(credential.ownerId, deliveryId).all<Record<string, unknown>>()
    return rows.results
  }

  async listRecords(credential: MachineCredential, limit = 50): Promise<Record<string, unknown>[]> {
    requireScope(credential, 'receipt:read')
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit) || 50))
    const rows = await this.database.prepare(`
      SELECT id, chain_id, external_ref AS source_id, position, action, delivery_id,
             occurred_at, received_at, sequence, sequence_status, commitment, manifest_hash,
             previous_proof, proof, anchor_status
      FROM events WHERE owner_id = ? AND track = 'M'
      ORDER BY received_at DESC, id DESC LIMIT ?
    `).bind(credential.ownerId, bounded).all<Record<string, unknown>>()
    return rows.results
  }
}

export interface TrackMRoutesDependencies {
  database(context: any): D1Database
  chainAppender(context: any): ChainAppender
  plans(context: any): MachinePlanProvider
  environment(context: any): 'dev' | 'prod'
  authenticateApiKey?(context: any): Promise<MachineCredential>
  authenticateOwner?(context: any): Promise<TrackMOwnerActor | null>
  authorizeSourceWrite?(actor: TrackMOwnerActor, context: any): Promise<void>
}

function routeError(context: any, error: unknown) {
  if (error instanceof DomainError) return context.json({ error: error.message, code: error.code }, error.status)
  throw error
}

/** Mount under `/api/v1`; record payloads are API-only and all reads are owner scoped. */
export function createTrackMRoutes(dependencies: TrackMRoutesDependencies): Hono {
  const routes = new Hono()
  const credential = (context: any) => dependencies.authenticateApiKey
    ? dependencies.authenticateApiKey(context)
    : authenticateMachineApiKey(dependencies.database(context), context.req.header('Authorization'), dependencies.environment(context))
  const sourceCredential = async (context: any, write: boolean): Promise<MachineCredential> => {
    if (context.req.header('Authorization') || !dependencies.authenticateOwner) return credential(context)
    const owner = await dependencies.authenticateOwner(context)
    if (!owner) throw new DomainError(401, 'authentication_required', 'Login or API key required')
    if (owner.role !== 'supplier') throw new DomainError(403, 'supplier_required', 'Supplier access required')
    if (write) {
      if (!dependencies.authorizeSourceWrite) throw new DomainError(403, 'active_plan_required', 'Source-write authorization is not configured')
      await dependencies.authorizeSourceWrite(owner, context)
    }
    return {
      keyId: `session:${owner.userId}`,
      ownerId: owner.userId,
      scopes: ['source:write', 'receipt:read', 'usage:read'],
      environment: dependencies.environment(context),
    }
  }
  const service = (context: any) => new TrackMService(dependencies.database(context), dependencies.chainAppender(context), dependencies.plans(context))

  routes.post('/sources', async (context) => {
    try {
      const body = await context.req.json<CreateSourceInput>()
      body.idempotency_key = context.req.header('Idempotency-Key') ?? body.idempotency_key
      return context.json(await service(context).createSource(await sourceCredential(context, true), body), 201)
    }
    catch (error) { return routeError(context, error) }
  })
  routes.get('/sources', async (context) => {
    try { return context.json({ sources: await service(context).listSources(await sourceCredential(context, false)) }) }
    catch (error) { return routeError(context, error) }
  })
  routes.get('/sources/:sourceId', async (context) => {
    try { return context.json(await service(context).getSource(await sourceCredential(context, false), context.req.param('sourceId'))) }
    catch (error) { return routeError(context, error) }
  })
  routes.post('/records', async (context) => {
    try {
      const body = await context.req.json<MachineRecordInput>()
      body.idempotency_key = context.req.header('Idempotency-Key') ?? body.idempotency_key
      return context.json(await service(context).appendRecord(await credential(context), body), 201)
    } catch (error) { return routeError(context, error) }
  })
  routes.post('/records:batch', async (context) => {
    try {
      const body = await context.req.json<{ records?: MachineRecordInput[] }>()
      return context.json({ records: await service(context).appendBatch(await credential(context), body.records ?? [], context.req.header('Idempotency-Key') ?? '') }, 201)
    } catch (error) { return routeError(context, error) }
  })
  routes.get('/receipts/:eventId', async (context) => {
    try { return context.json(await service(context).getReceipt(await credential(context), context.req.param('eventId'))) }
    catch (error) { return routeError(context, error) }
  })
  routes.get('/records', async (context) => {
    try { return context.json({ records: await service(context).listRecords(await sourceCredential(context, false), Number(context.req.query('limit') ?? 50)) }) }
    catch (error) { return routeError(context, error) }
  })
  routes.get('/sources/:sourceId/chain', async (context) => {
    try { return context.json({ events: await service(context).sourceChain(await credential(context), context.req.param('sourceId')) }) }
    catch (error) { return routeError(context, error) }
  })
  routes.get('/deliveries/:deliveryId/events', async (context) => {
    try { return context.json({ events: await service(context).deliveryEvents(await credential(context), context.req.param('deliveryId')) }) }
    catch (error) { return routeError(context, error) }
  })
  routes.get('/usage', async (context) => {
    try { return context.json(await service(context).usage(await credential(context))) }
    catch (error) { return routeError(context, error) }
  })
  return routes
}

export interface TrackMManagementRoutesDependencies {
  database(context: any): D1Database
  environment(context: any): 'dev' | 'prod'
  authenticateOwner(context: any): Promise<TrackMOwnerActor | null>
  authorizeKeyWrite(actor: TrackMOwnerActor, context: any): Promise<void>
}

/** Mount under `/api`; plaintext keys are returned only by POST `/api-keys`. */
export function createTrackMManagementRoutes(dependencies: TrackMManagementRoutesDependencies): Hono {
  const routes = new Hono()
  const owner = async (context: any, write = false): Promise<TrackMOwnerActor> => {
    const actor = await dependencies.authenticateOwner(context)
    if (!actor) throw new DomainError(401, 'authentication_required', 'Login required')
    if (actor.role !== 'supplier') throw new DomainError(403, 'supplier_required', 'Supplier access required')
    if (write) await dependencies.authorizeKeyWrite(actor, context)
    return actor
  }
  const service = (context: any) => new TrackMApiKeyService(dependencies.database(context), dependencies.environment(context))
  routes.get('/api-keys', async (context) => {
    try { return context.json({ keys: await service(context).list((await owner(context)).userId) }) }
    catch (error) { return routeError(context, error) }
  })
  routes.post('/api-keys', async (context) => {
    try {
      const actor = await owner(context, true)
      const body = await context.req.json<{ label?: string; scopes?: MachineScope[]; expires_at?: string | null }>()
      const created = await service(context).issue(actor.userId, body.label ?? '', body.scopes ?? [], body.expires_at)
      return context.json({ id: created.id, api_key: created.key, key_prefix: created.prefix, scopes: created.scopes }, 201)
    } catch (error) { return routeError(context, error) }
  })
  routes.delete('/api-keys/:keyId', async (context) => {
    try {
      await service(context).revoke((await owner(context, true)).userId, context.req.param('keyId'))
      return context.json({ revoked: true })
    } catch (error) { return routeError(context, error) }
  })
  routes.post('/api-keys/:keyId/rotate', async (context) => {
    try {
      const actor = await owner(context, true)
      const rotated = await service(context).rotate(actor.userId, context.req.param('keyId'))
      return context.json({
        id: rotated.id,
        api_key: rotated.key,
        key_prefix: rotated.prefix,
        scopes: rotated.scopes,
      }, 201)
    } catch (error) { return routeError(context, error) }
  })
  return routes
}
