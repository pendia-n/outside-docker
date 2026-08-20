import type { Env } from './types'

export type DatabaseEnvironment = Env['ENV']
export type D1Executor = D1Database | D1DatabaseSession
export type BindValue = string | number | null | ArrayBuffer | ArrayBufferView

export interface SqlStatement {
  sql: string
  values?: readonly BindValue[]
}

export interface SeekCursor {
  createdAt: string
  id: string
}

export interface CursorPageRequest {
  cursor: SeekCursor | null
  limit: number
}

export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
}

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const MAX_CURSOR_LENGTH = 2_048

/** Selects exactly one D1 binding for the configured Worker environment. */
export function databaseFor(env: Pick<Env, 'ENV' | 'DB_DEV' | 'DB_PROD'>): D1Database {
  if (env.ENV === 'dev') return env.DB_DEV
  if (env.ENV === 'prod') return env.DB_PROD
  throw new Error(`Unsupported database environment: ${String(env.ENV)}`)
}

/** Backwards-friendly alias for route and service modules. */
export const selectDatabase = databaseFor

/** Creates a session whose first read is served by the primary D1 instance. */
export function primarySession(database: D1Database): D1DatabaseSession {
  return database.withSession('first-primary')
}

export function prepare(
  database: D1Executor,
  sql: string,
  values: readonly BindValue[] = [],
): D1PreparedStatement {
  const statement = database.prepare(sql)
  return values.length > 0 ? statement.bind(...values) : statement
}

export async function queryFirst<T extends Record<string, unknown>>(
  database: D1Executor,
  sql: string,
  values: readonly BindValue[] = [],
): Promise<T | null> {
  return prepare(database, sql, values).first<T>()
}

export async function queryAll<T extends Record<string, unknown>>(
  database: D1Executor,
  sql: string,
  values: readonly BindValue[] = [],
): Promise<T[]> {
  const result = await prepare(database, sql, values).all<T>()
  return result.results
}

export async function execute(
  database: D1Executor,
  sql: string,
  values: readonly BindValue[] = [],
): Promise<D1Result> {
  return prepare(database, sql, values).run()
}

/**
 * D1 executes a batch sequentially and rolls the batch back when a statement
 * fails. Use this helper for related writes; cross-request chain serialization
 * still belongs in the chain Durable Object.
 */
export async function executeBatch<T extends Record<string, unknown> = Record<string, unknown>>(
  database: D1Executor,
  statements: readonly SqlStatement[],
): Promise<D1Result<T>[]> {
  if (statements.length === 0) return []
  const prepared = statements.map(({ sql, values }) => prepare(database, sql, values))
  return database.batch<T>(prepared)
}

export function newId(prefix?: string): string {
  const id = crypto.randomUUID()
  return prefix ? `${prefix}_${id}` : id
}

export function nowIso(date = new Date()): string {
  return date.toISOString()
}

export function addSecondsIso(seconds: number, from = new Date()): string {
  if (!Number.isFinite(seconds)) throw new TypeError('seconds must be finite')
  return new Date(from.getTime() + seconds * 1_000).toISOString()
}

export function parsePageLimit(
  value: string | number | null | undefined,
  defaultLimit = DEFAULT_PAGE_SIZE,
  maxLimit = MAX_PAGE_SIZE,
): number {
  if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 1) {
    throw new RangeError('defaultLimit must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxLimit) || maxLimit < defaultLimit) {
    throw new RangeError('maxLimit must be a safe integer greater than or equal to defaultLimit')
  }
  if (value === null || value === undefined || value === '') return defaultLimit

  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return defaultLimit
  return Math.min(parsed, maxLimit)
}

export function encodePageCursor(cursor: SeekCursor): string {
  assertCursor(cursor)
  const encoded = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of encoded) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function decodePageCursor(value: string | null | undefined): SeekCursor | null {
  if (!value) return null
  if (value.length > MAX_CURSOR_LENGTH) throw new InvalidPageCursorError()

  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    assertCursor(parsed)
    return parsed
  } catch (error) {
    if (error instanceof InvalidPageCursorError) throw error
    throw new InvalidPageCursorError()
  }
}

export function parseCursorPage(input: {
  cursor?: string | null
  limit?: string | number | null
}): CursorPageRequest {
  return {
    cursor: decodePageCursor(input.cursor),
    limit: parsePageLimit(input.limit),
  }
}

/**
 * Finalizes rows queried with LIMIT requestedLimit + 1. Rows must be ordered by
 * `(created_at DESC, id DESC)` (or the same fields in ascending order).
 */
export function finishCursorPage<T extends { created_at: string; id: string }>(
  rows: readonly T[],
  requestedLimit: number,
): CursorPage<T> {
  const limit = parsePageLimit(requestedLimit)
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  const last = hasMore ? items.at(-1) : undefined
  return {
    items,
    nextCursor: last ? encodePageCursor({ createdAt: last.created_at, id: last.id }) : null,
  }
}

export class InvalidPageCursorError extends Error {
  constructor() {
    super('Invalid pagination cursor')
    this.name = 'InvalidPageCursorError'
  }
}

function assertCursor(value: unknown): asserts value is SeekCursor {
  if (
    !value
    || typeof value !== 'object'
    || typeof (value as SeekCursor).createdAt !== 'string'
    || typeof (value as SeekCursor).id !== 'string'
    || (value as SeekCursor).createdAt.length === 0
    || (value as SeekCursor).id.length === 0
  ) {
    throw new InvalidPageCursorError()
  }
}

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /(?:UNIQUE constraint failed|constraint failed.*unique)/i.test(error.message)
}
