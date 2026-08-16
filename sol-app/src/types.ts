export interface Env {
  DB_DEV: D1Database
  DB_PROD: D1Database
  ENV: 'dev' | 'prod'
  JWT_SECRET: string
  POLYGON_CONTRACT_ADDRESS_DEV: string
  POLYGON_CONTRACT_ADDRESS_PROD: string
  POLYGON_CHAIN_ID: string
}

export type Role = 'supplier' | 'verifier'

export interface SessionClaims {
  sub: string
  username: string
  role: Role
  type: 'session'
  iat: number
  exp: number
}
