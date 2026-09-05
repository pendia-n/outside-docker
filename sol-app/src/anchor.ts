import { canonicalSha256, canonicalize, sha256Bytes } from './canonical'
import { DomainError } from './chain-do'
import { buildMerkleTree, toBytes32, type MerkleLeafInput, type MerkleProofStep } from './merkle'

export type AnchorBatchStatus = 'pending' | 'submitted' | 'confirmed' | 'retry' | 'failed'

export interface PendingAnchorEvent {
  id: string
  proof: string
  received_at: string
}

export interface PreparedAnchorLeaf {
  eventId: string
  eventProof: string
  index: number
  leafHash: string
  proof: MerkleProofStep[]
}

export interface PreparedAnchorMaterial {
  batchRef: string
  merkleRoot: string
  manifestHash: string
  manifestJson: string
  leaves: PreparedAnchorLeaf[]
}

export interface AnchorTransactionReceipt {
  status?: number | bigint | null
  blockNumber?: number | bigint
  blockHash?: string
  contractTimestamp?: string
}

export interface AnchorTransaction {
  hash: string
  wait(confirmations?: number): Promise<AnchorTransactionReceipt | null>
}

export interface PolygonAnchorClient {
  anchorBatch(input: {
    batchId: `0x${string}`
    merkleRoot: `0x${string}`
    manifestHash: `0x${string}`
    leafCount: number
    eventCount: number
  }): Promise<AnchorTransaction>
  transactionStatus?(transactionHash: string): Promise<{
    state: 'pending' | 'confirmed' | 'failed' | 'missing'
    receipt?: AnchorTransactionReceipt
  }>
}

export interface EthersAnchorContractLike {
  anchorBatch(batchId: string, merkleRoot: string, manifestHash: string, leafCount: number, eventCount: number): Promise<{
    hash: string
    wait(confirmations?: number): Promise<AnchorTransactionReceipt | null>
  }>
}

export function createEthersAnchorClient(contract: EthersAnchorContractLike): PolygonAnchorClient {
  return {
    anchorBatch(input) {
      return contract.anchorBatch(input.batchId, input.merkleRoot, input.manifestHash, input.leafCount, input.eventCount)
    },
  }
}

export interface AnchorConfiguration {
  environment: 'dev' | 'prod'
  chainId: string
  network: string
  contractAddress: string
  batchSize?: number
  confirmations?: number
  maxAttempts?: number
  retryBaseSeconds?: number
}

export interface AnchorBatchRow {
  id: string
  batch_ref: string
  status: AnchorBatchStatus
  merkle_root: string
  manifest_hash: string
  leaf_count: number
  event_count: number
  attempt_count: number
  next_retry_at: string | null
  tx_hash: string | null
  submitted_at?: string | null
}

function checkDigest(value: string, label: string): string {
  const normalized = value.toLowerCase().replace(/^0x/, '')
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new DomainError(500, 'invalid_anchor_digest', `${label} is not a SHA-256 digest`)
  return normalized
}

export async function buildAnchorMaterial(events: readonly PendingAnchorEvent[]): Promise<PreparedAnchorMaterial> {
  if (events.length === 0) throw new DomainError(400, 'empty_anchor_batch', 'Cannot build an empty anchor batch')
  const inputs: MerkleLeafInput[] = events.map((event) => ({ eventId: event.id, proof: checkDigest(event.proof, 'event proof') }))
  const tree = await buildMerkleTree(inputs)
  const manifest = {
    version: 'OD-ANCHOR-MANIFEST-1',
    merkle_algorithm: tree.algorithm,
    event_count: events.length,
    leaves: tree.leaves.map((leaf) => ({
      event_id: leaf.value.eventId,
      event_proof: leaf.value.proof,
      leaf_index: leaf.index,
      leaf_hash: leaf.hash,
    })),
  }
  const manifestJson = canonicalize(manifest)
  const manifestHash = await canonicalSha256(manifest)
  const batchRef = await sha256Bytes(`OD1|ANCHOR|${tree.root}|${manifestHash}|${events.length}`)
  return {
    batchRef,
    merkleRoot: tree.root,
    manifestHash,
    manifestJson,
    leaves: tree.leaves.map((leaf) => ({
      eventId: leaf.value.eventId,
      eventProof: leaf.value.proof,
      index: leaf.index,
      leafHash: leaf.hash,
      proof: leaf.proof,
    })),
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 2000)
}

function safeInteger(value: number | bigint | undefined): number | null {
  if (value == null) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

export class PolygonAnchorService {
  private readonly batchSize: number
  private readonly confirmations: number
  private readonly maxAttempts: number
  private readonly retryBaseSeconds: number

  constructor(
    private readonly database: D1Database,
    private readonly client: PolygonAnchorClient,
    private readonly configuration: AnchorConfiguration,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.batchSize = Math.max(1, Math.min(500, configuration.batchSize ?? 100))
    this.confirmations = Math.max(1, configuration.confirmations ?? 2)
    this.maxAttempts = Math.max(1, configuration.maxAttempts ?? 8)
    this.retryBaseSeconds = Math.max(5, configuration.retryBaseSeconds ?? 30)
  }

  async prepareBatch(): Promise<AnchorBatchRow | null> {
    const pending = await this.database.prepare(`
      SELECT id, proof, received_at FROM events
      WHERE anchor_status = 'pending_anchor' AND anchor_batch_id IS NULL
      ORDER BY received_at ASC, id ASC LIMIT ?
    `).bind(this.batchSize).all<PendingAnchorEvent>()
    return this.persistPreparedBatch(pending.results)
  }

  async preparePriorityBatch(): Promise<AnchorBatchRow | null> {
    const request = await this.database.prepare(`
      SELECT id, supplier_user_id, event_type_ref, range_start, range_end
      FROM priority_anchor_requests
      WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1
    `).first<{ id: string; supplier_user_id: string; event_type_ref: string; range_start: string; range_end: string }>()
    if (!request) return null
    const pending = await this.database.prepare(`
      SELECT id, proof, received_at FROM events
      WHERE owner_id = ? AND event_type = ?
        AND COALESCE(occurred_at, received_at) >= ? AND COALESCE(occurred_at, received_at) < ?
        AND anchor_status = 'pending_anchor' AND anchor_batch_id IS NULL
      ORDER BY received_at ASC, id ASC LIMIT ?
    `).bind(request.supplier_user_id, request.event_type_ref.toUpperCase(), request.range_start, request.range_end, this.batchSize).all<PendingAnchorEvent>()
    if (pending.results.length === 0) {
      const completedAt = this.now().toISOString()
      await this.database.prepare(`
        UPDATE priority_anchor_requests SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(completedAt, completedAt, request.id).run()
      return null
    }
    return this.persistPreparedBatch(pending.results, request.id)
  }

  private async persistPreparedBatch(pendingEvents: readonly PendingAnchorEvent[], priorityRequestId?: string): Promise<AnchorBatchRow | null> {
    if (pendingEvents.length === 0) return null

    const material = await buildAnchorMaterial(pendingEvents)
    const id = crypto.randomUUID()
    const createdAt = this.now().toISOString()
    const statements: D1PreparedStatement[] = [this.database.prepare(`
      INSERT INTO anchor_batches (
        id, environment, batch_ref, status, merkle_root, manifest_hash, leaf_count,
        event_count, attempt_count, next_retry_at, last_error, tx_hash, block_number,
        chain_id, network, contract_address, submitted_at, confirmed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?)
    `).bind(
      id,
      this.configuration.environment,
      material.batchRef,
      material.merkleRoot,
      material.manifestHash,
      material.leaves.length,
      pendingEvents.length,
      this.configuration.chainId,
      this.configuration.network,
      this.configuration.contractAddress,
      createdAt,
      createdAt,
    )]
    for (const leaf of material.leaves) {
      statements.push(this.database.prepare(`
        INSERT INTO anchor_batch_events (
          batch_id, event_id, leaf_index, leaf_hash, merkle_proof_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(id, leaf.eventId, leaf.index, leaf.leafHash, canonicalize(leaf.proof), createdAt))
      statements.push(this.database.prepare(`
        UPDATE events SET anchor_batch_id = ?, anchor_status = 'batching', updated_at = ?
        WHERE id = ? AND anchor_batch_id IS NULL AND anchor_status = 'pending_anchor'
      `).bind(id, createdAt, leaf.eventId))
      statements.push(this.database.prepare(
        "UPDATE receipts SET anchor_status = 'batching', updated_at = ? WHERE event_id = ?",
      ).bind(createdAt, leaf.eventId))
    }
    if (priorityRequestId) {
      statements.push(this.database.prepare(`
        UPDATE priority_anchor_requests SET status = 'batching', anchor_batch_id = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(id, createdAt, priorityRequestId))
    }
    await this.database.batch(statements)
    return {
      id,
      batch_ref: material.batchRef,
      status: 'pending',
      merkle_root: material.merkleRoot,
      manifest_hash: material.manifestHash,
      leaf_count: material.leaves.length,
      event_count: pendingEvents.length,
      attempt_count: 0,
      next_retry_at: null,
      tx_hash: null,
    }
  }

  async dueBatches(limit = 10): Promise<AnchorBatchRow[]> {
    const now = this.now().toISOString()
    const rows = await this.database.prepare(`
      SELECT id, batch_ref, status, merkle_root, manifest_hash, leaf_count, event_count,
             attempt_count, next_retry_at, tx_hash
      FROM anchor_batches
      WHERE environment = ? AND status IN ('pending', 'retry')
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC LIMIT ?
    `).bind(this.configuration.environment, now, Math.max(1, Math.min(100, limit))).all<AnchorBatchRow>()
    return rows.results
  }

  /**
   * Reconciles work interrupted after a batch was claimed. A confirmed
   * transaction is finalized without rebroadcasting; a dropped/failed
   * transaction returns to the normal bounded retry policy.
   */
  async recoverStaleSubmitted(staleAfterSeconds = 15 * 60, limit = 20): Promise<number> {
    const staleBefore = new Date(this.now().valueOf() - Math.max(60, staleAfterSeconds) * 1000).toISOString()
    const rows = await this.database.prepare(`
      SELECT id, batch_ref, status, merkle_root, manifest_hash, leaf_count, event_count,
             attempt_count, next_retry_at, tx_hash, submitted_at
      FROM anchor_batches
      WHERE environment = ? AND status = 'submitted' AND submitted_at < ?
      ORDER BY submitted_at ASC LIMIT ?
    `).bind(this.configuration.environment, staleBefore, Math.max(1, Math.min(100, limit))).all<AnchorBatchRow>()
    let recovered = 0
    for (const batch of rows.results) {
      if (!batch.tx_hash) {
        await this.requeueInterrupted(batch, 'Anchoring stopped before a transaction hash was recorded')
        recovered += 1
        continue
      }
      if (!this.client.transactionStatus) continue
      const transaction = await this.client.transactionStatus(batch.tx_hash)
      if (transaction.state === 'pending') continue
      if (transaction.state === 'confirmed' && transaction.receipt) {
        await this.confirmRecovered(batch, transaction.receipt)
      } else {
        await this.requeueInterrupted(
          batch,
          transaction.state === 'failed'
            ? 'Base transaction failed before confirmation'
            : 'Base transaction is no longer available',
        )
      }
      recovered += 1
    }
    return recovered
  }

  private async confirmRecovered(batch: AnchorBatchRow, receipt: AnchorTransactionReceipt): Promise<void> {
    const confirmedAt = this.now().toISOString()
    await this.database.batch([
      this.database.prepare(`
        UPDATE anchor_batches SET status = 'confirmed', block_number = ?, block_hash = ?,
          contract_timestamp = ?, confirmed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'submitted' AND tx_hash = ?
      `).bind(
        safeInteger(receipt.blockNumber),
        receipt.blockHash ?? null,
        receipt.contractTimestamp ?? null,
        confirmedAt,
        confirmedAt,
        batch.id,
        batch.tx_hash,
      ),
      this.database.prepare(`
        UPDATE anchor_attempts SET status = 'confirmed', completed_at = ?
        WHERE batch_id = ? AND attempt_number = ? AND status = 'submitted'
      `).bind(confirmedAt, batch.id, batch.attempt_count),
      this.database.prepare(
        "UPDATE events SET anchor_status = 'anchored', updated_at = ? WHERE anchor_batch_id = ?",
      ).bind(confirmedAt, batch.id),
      this.database.prepare(`
        UPDATE receipts SET anchor_status = 'anchored', updated_at = ?
        WHERE event_id IN (SELECT event_id FROM anchor_batch_events WHERE batch_id = ?)
      `).bind(confirmedAt, batch.id),
      this.database.prepare(`
        UPDATE priority_anchor_requests SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE anchor_batch_id = ? AND status = 'batching'
      `).bind(confirmedAt, confirmedAt, batch.id),
    ])
  }

  private async requeueInterrupted(batch: AnchorBatchRow, message: string): Promise<void> {
    const now = this.now()
    const terminal = batch.attempt_count >= this.maxAttempts
    const status: AnchorBatchStatus = terminal ? 'failed' : 'retry'
    const retryAt = terminal ? null : new Date(now.valueOf() + this.retryBaseSeconds * 1000).toISOString()
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        UPDATE anchor_batches SET status = ?, next_retry_at = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'submitted' AND attempt_count = ?
      `).bind(status, retryAt, message, now.toISOString(), batch.id, batch.attempt_count),
      this.database.prepare(`
        UPDATE anchor_attempts SET status = 'failed', error_message = ?, completed_at = ?
        WHERE batch_id = ? AND attempt_number = ? AND status = 'submitted'
      `).bind(message, now.toISOString(), batch.id, batch.attempt_count),
    ]
    if (terminal) {
      statements.push(this.database.prepare(
        "UPDATE events SET anchor_status = 'anchor_failed', updated_at = ? WHERE anchor_batch_id = ?",
      ).bind(now.toISOString(), batch.id))
      statements.push(this.database.prepare(`
        UPDATE receipts SET anchor_status = 'anchor_failed', updated_at = ?
        WHERE event_id IN (SELECT event_id FROM anchor_batch_events WHERE batch_id = ?)
      `).bind(now.toISOString(), batch.id))
    }
    await this.database.batch(statements)
  }

  async submitBatch(batch: AnchorBatchRow): Promise<AnchorBatchRow> {
    if (batch.status !== 'pending' && batch.status !== 'retry') throw new DomainError(409, 'anchor_not_submittable', 'Anchor batch is not pending or retryable')
    const attempt = batch.attempt_count + 1
    const submittedAt = this.now().toISOString()
    const claimed = await this.database.prepare(`
      UPDATE anchor_batches SET status = 'submitted', attempt_count = ?, next_retry_at = NULL,
        last_error = NULL, submitted_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retry') AND attempt_count = ?
    `).bind(attempt, submittedAt, submittedAt, batch.id, batch.attempt_count).run()
    if (!claimed.meta.changes) throw new DomainError(409, 'anchor_already_claimed', 'Anchor batch is already being processed')
    const attemptId = crypto.randomUUID()
    await this.database.prepare(`
      INSERT INTO anchor_attempts (id, batch_id, attempt_number, status, submitted_at, created_at)
      VALUES (?, ?, ?, 'submitted', ?, ?)
    `).bind(attemptId, batch.id, attempt, submittedAt, submittedAt).run()

    try {
      const transaction = await this.client.anchorBatch({
        batchId: toBytes32(batch.batch_ref),
        merkleRoot: toBytes32(batch.merkle_root),
        manifestHash: toBytes32(batch.manifest_hash),
        leafCount: batch.leaf_count,
        eventCount: batch.event_count,
      })
      if (!/^0x[a-fA-F0-9]{64}$/.test(transaction.hash)) throw new Error('Base client returned an invalid transaction hash')
      await this.database.prepare(
        "UPDATE anchor_batches SET tx_hash = ?, updated_at = ? WHERE id = ? AND status = 'submitted'",
      ).bind(transaction.hash, this.now().toISOString(), batch.id).run()
      await this.database.prepare(
        'UPDATE anchor_attempts SET tx_hash = ? WHERE id = ?',
      ).bind(transaction.hash, attemptId).run()
      const receipt = await transaction.wait(this.confirmations)
      if (!receipt || (receipt.status != null && Number(receipt.status) !== 1)) throw new Error('Base transaction was not confirmed successfully')
      const confirmedAt = this.now().toISOString()
      const statements = [
        this.database.prepare(`
          UPDATE anchor_batches SET status = 'confirmed', tx_hash = ?, block_number = ?,
            block_hash = ?, contract_timestamp = ?, confirmed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'submitted'
        `).bind(transaction.hash, safeInteger(receipt.blockNumber), receipt.blockHash ?? null, receipt.contractTimestamp ?? null, confirmedAt, confirmedAt, batch.id),
        this.database.prepare("UPDATE anchor_attempts SET status = 'confirmed', completed_at = ? WHERE id = ?").bind(confirmedAt, attemptId),
        this.database.prepare("UPDATE events SET anchor_status = 'anchored', updated_at = ? WHERE anchor_batch_id = ?").bind(confirmedAt, batch.id),
        this.database.prepare(`
          UPDATE receipts SET anchor_status = 'anchored', updated_at = ?
          WHERE event_id IN (SELECT event_id FROM anchor_batch_events WHERE batch_id = ?)
        `).bind(confirmedAt, batch.id),
        this.database.prepare(`
          UPDATE priority_anchor_requests SET status = 'completed', completed_at = ?, updated_at = ?
          WHERE anchor_batch_id = ? AND status = 'batching'
        `).bind(confirmedAt, confirmedAt, batch.id),
      ]
      await this.database.batch(statements)
      return { ...batch, status: 'confirmed', attempt_count: attempt, tx_hash: transaction.hash }
    } catch (error) {
      return this.failAttempt(batch, attemptId, attempt, error)
    }
  }

  private async failAttempt(batch: AnchorBatchRow, attemptId: string, attempt: number, error: unknown): Promise<AnchorBatchRow> {
    const failedAt = this.now()
    const terminal = attempt >= this.maxAttempts
    const status: AnchorBatchStatus = terminal ? 'failed' : 'retry'
    const delaySeconds = this.retryBaseSeconds * Math.min(2 ** Math.max(0, attempt - 1), 256)
    const retryAt = terminal ? null : new Date(failedAt.valueOf() + delaySeconds * 1000).toISOString()
    const message = errorText(error)
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        UPDATE anchor_batches SET status = ?, next_retry_at = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'submitted'
      `).bind(status, retryAt, message, failedAt.toISOString(), batch.id),
      this.database.prepare(`
        UPDATE anchor_attempts SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?
      `).bind(message, failedAt.toISOString(), attemptId),
    ]
    if (terminal) {
      statements.push(this.database.prepare("UPDATE events SET anchor_status = 'anchor_failed', updated_at = ? WHERE anchor_batch_id = ?").bind(failedAt.toISOString(), batch.id))
      statements.push(this.database.prepare(`
        UPDATE receipts SET anchor_status = 'anchor_failed', updated_at = ?
        WHERE event_id IN (SELECT event_id FROM anchor_batch_events WHERE batch_id = ?)
      `).bind(failedAt.toISOString(), batch.id))
      statements.push(this.database.prepare(`
        UPDATE priority_anchor_requests SET status = 'failed', last_error = ?, updated_at = ?
        WHERE anchor_batch_id = ? AND status = 'batching'
      `).bind(message, failedAt.toISOString(), batch.id))
    }
    await this.database.batch(statements)
    return { ...batch, status, attempt_count: attempt, next_retry_at: retryAt }
  }

  /** Called by a Worker's scheduled handler. */
  async runScheduled(): Promise<{ prepared: string | null; submitted: number; confirmed: number; retrying: number; failed: number }> {
    await this.recoverStaleSubmitted()
    const priority = await this.preparePriorityBatch()
    const prepared = priority ?? await this.prepareBatch()
    const due = await this.dueBatches()
    const summary = { prepared: prepared?.id ?? null, submitted: 0, confirmed: 0, retrying: 0, failed: 0 }
    for (const batch of due) {
      const result = await this.submitBatch(batch)
      summary.submitted += 1
      if (result.status === 'confirmed') summary.confirmed += 1
      else if (result.status === 'retry') summary.retrying += 1
      else if (result.status === 'failed') summary.failed += 1
    }
    return summary
  }
}

export function createScheduledAnchorHandler(dependencies: {
  database(environment: any): D1Database
  client(environment: any): PolygonAnchorClient
  configuration(environment: any): AnchorConfiguration
}) {
  return async (_controller: ScheduledController, environment: any, execution: ExecutionContext): Promise<void> => {
    const service = new PolygonAnchorService(
      dependencies.database(environment),
      dependencies.client(environment),
      dependencies.configuration(environment),
    )
    execution.waitUntil(service.runScheduled())
  }
}
