export type Environment = 'dev' | 'prod'
export type Role = 'supplier' | 'verifier'
export type SupplierMode = 'H' | 'M' | 'both'
export type Track = 'H' | 'M'
export type PlanCode = 'A' | 'B' | 'C' | 'D'
export type EventAnchorStatus =
  | 'pending_anchor'
  | 'anchoring'
  | 'batching'
  | 'submitted'
  | 'anchored'
  | 'anchor_failed'

export type { SessionClaimsV1, CurrentUser, ActiveEntitlement } from './auth'
export type { ReceiptAnchorStatus, ReceiptPayload, SignedReceipt } from './receipts'
export type { ChainAppendInput, ChainAppendResult } from './chain-do'

export interface Env {
  DB_DEV: D1Database
  DB_PROD: D1Database
  CHAIN_COORDINATOR: DurableObjectNamespace
  ENV: Environment
  APP_ORIGIN?: string

  JWT_SECRET: string
  CSRF_SECRET?: string
  TOTP_ENCRYPTION_KEY?: string
  TOTP_KEY_ID?: string
  TOTP_RECOVERY_PEPPER?: string
  TOTP_RECOVERY_KEY_ID?: string
  RECEIPT_PRIVATE_KEY_JWK?: string
  RECEIPT_PUBLIC_KEY_JWK?: string
  RECEIPT_KEY_ID?: string

  STRIPE_API_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_PRICE_PLAN_A?: string
  STRIPE_PRICE_PLAN_B?: string
  STRIPE_PRICE_PLAN_C?: string
  STRIPE_PRICE_PLAN_D?: string
  STRIPE_PRICE_READ_PASS?: string

  BASE_RPC_URL?: string
  BASE_PRIVATE_KEY?: string
  BASE_CONTRACT_ADDRESS_DEV: string
  BASE_CONTRACT_ADDRESS_PROD: string
  BASE_CHAIN_ID_DEV: string
  BASE_CHAIN_ID_PROD: string
  BASE_CONFIRMATIONS?: string
}

export interface ApiFailure {
  error: string
  code?: string
  detail?: string
  request_id?: string
}

export const PLAN_LIMITS: Record<PlanCode, { writesPerMinute: number; recordsPerWrite: number }> = {
  A: { writesPerMinute: 2, recordsPerWrite: 250 },
  B: { writesPerMinute: 4, recordsPerWrite: 700 },
  C: { writesPerMinute: 10, recordsPerWrite: 1_150 },
  D: { writesPerMinute: 20, recordsPerWrite: 2_000 },
}
