import { DomainError } from './chain-do'
import type { MachinePlan, MachinePlanProvider } from './track-m'
import type { PlanCode } from './types'

export interface ActiveWriterPlan extends MachinePlan {
  entitlementId: string
  planCode: PlanCode
  validUntil: string
}

interface WriterPlanRow {
  entitlement_id: string
  plan_code: PlanCode
  valid_until: string
  write_rate_per_minute: number | null
  records_per_write: number | null
  default_write_rate: number
  default_records_per_write: number
}

export async function activeWriterPlan(database: D1Database, ownerId: string, now = new Date()): Promise<ActiveWriterPlan | null> {
  const row = await database.prepare(`
    SELECT e.id AS entitlement_id, e.plan_code, e.valid_until,
           e.write_rate_per_minute, e.records_per_write,
           p.write_rate_per_minute AS default_write_rate,
           p.records_per_write AS default_records_per_write
    FROM entitlements e JOIN billing_plans p ON p.code = e.plan_code
    WHERE e.user_id = ? AND e.kind = 'writer_plan'
      AND e.status IN ('active', 'trialing')
      AND e.valid_from <= ? AND e.valid_until > ? AND p.is_active = 1
    ORDER BY e.valid_until DESC LIMIT 1
  `).bind(ownerId, now.toISOString(), now.toISOString()).first<WriterPlanRow>()
  if (!row || !['A', 'B', 'C', 'D'].includes(row.plan_code)) return null
  const writesPerMinute = Number(row.write_rate_per_minute ?? row.default_write_rate)
  const recordsPerWrite = Number(row.records_per_write ?? row.default_records_per_write)
  if (!Number.isSafeInteger(writesPerMinute) || writesPerMinute <= 0 || !Number.isSafeInteger(recordsPerWrite) || recordsPerWrite <= 0) {
    throw new DomainError(500, 'invalid_plan_configuration', 'Writer plan limits are invalid')
  }
  return {
    active: true,
    entitlementId: row.entitlement_id,
    planCode: row.plan_code,
    validUntil: row.valid_until,
    writesPerMinute,
    recordsPerWrite,
  }
}

export function machinePlanProvider(database: D1Database): MachinePlanProvider {
  return { getPlan: (ownerId) => activeWriterPlan(database, ownerId) }
}

/** Atomic per-minute limiter shared by Track H session writes. */
export async function consumeHumanWrite(database: D1Database, ownerId: string): Promise<ActiveWriterPlan> {
  const plan = await activeWriterPlan(database, ownerId)
  if (!plan) throw new DomainError(402, 'active_plan_required', 'An active supplier plan is required')
  const now = new Date()
  const bucket = new Date(Math.floor(now.valueOf() / 60_000) * 60_000).toISOString()
  const result = await database.prepare(`
    INSERT INTO rate_limit_counters (
      owner_id, credential_type, credential_id, route_key, window_start,
      window_seconds, request_count, record_count, updated_at
    ) VALUES (?, 'session', ?, 'track_h:write', ?, 60, 1, 1, ?)
    ON CONFLICT(credential_type, credential_id, route_key, window_start, window_seconds)
    DO UPDATE SET request_count = rate_limit_counters.request_count + 1,
                  record_count = rate_limit_counters.record_count + 1,
                  updated_at = excluded.updated_at
    WHERE rate_limit_counters.request_count < ?
  `).bind(ownerId, ownerId, bucket, now.toISOString(), plan.writesPerMinute).run()
  if (!result.meta.changes) throw new DomainError(429, 'write_rate_exceeded', `Plan permits ${plan.writesPerMinute} writes per minute`)
  return plan
}
