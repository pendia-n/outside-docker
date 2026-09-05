import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  STRIPE_API_VERSION,
  StripeRestClient,
  StripeWebhookError,
  createD1BillingEventHandler,
  createStripeSignatureHeader,
  processStripeWebhook,
  verifyStripeWebhook,
  type StripeWebhookClaimInput,
  type StripeWebhookStore,
} from './billing'

class TestStatement {
  private readonly database: DatabaseSync
  private readonly sql: string
  private readonly values: unknown[]

  constructor(
    database: DatabaseSync,
    sql: string,
    values: unknown[] = [],
  ) {
    this.database = database
    this.sql = sql
    this.values = values
  }

  bind(...values: unknown[]): TestStatement { return new TestStatement(this.database, this.sql, values) }
  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values as any[]) as T | undefined) ?? null
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.values as any[]) as T[] }
  }
  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values as any[])
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(':memory:')
  prepare(sql: string): TestStatement { return new TestStatement(this.sqlite, sql) }
  async batch(statements: TestStatement[]): Promise<unknown[]> {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      this.sqlite.exec('COMMIT')
      return results
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }
}

function migratedDatabase(): TestD1 {
  const database = new TestD1()
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  database.sqlite.exec(readFileSync(join(sourceDirectory, '../migrations/0001_init.sql'), 'utf8'))
  database.sqlite.exec(readFileSync(join(sourceDirectory, '../migrations/0002_phase1.sql'), 'utf8'))
  return database
}

test('Checkout uses dahlia API, integration identifiers, idempotency, and dynamic payment methods', async () => {
  let captured: RequestInit | undefined
  const client = new StripeRestClient({
    apiKey: 'rk_test_abcdefghijklmnopqrstuvwxyz123456',
    fetch: async (_input, init) => {
      captured = init
      return new Response(JSON.stringify({
        id: 'cs_test_123456', object: 'checkout.session', url: 'https://checkout.stripe.test/session',
        mode: 'subscription', status: 'open', payment_status: 'unpaid', customer: null,
        subscription: null, payment_intent: null, metadata: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await client.createSupplierSubscriptionCheckout({
    pendingRegistrationId: 'pending-123', planCode: 'A', priceId: 'price_123456', username: 'alice_01',
    successUrl: 'http://localhost/success?session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'http://localhost/cancel',
    idempotencyKey: 'checkout:pending-123', environment: 'dev',
  })
  const headers = new Headers(captured?.headers)
  const body = new URLSearchParams(captured?.body as string)
  assert.equal(headers.get('Stripe-Version'), STRIPE_API_VERSION)
  assert.equal(headers.get('Idempotency-Key'), 'checkout:pending-123')
  assert.equal(body.has('payment_method_types'), false)
  assert.match(body.get('integration_identifier') ?? '', /^outside_docker_supplier_[a-z]{8}$/)
  assert.equal(body.get('mode'), 'subscription')
})

test('one-time access Checkout uses server quantities across full and discounted prices', async () => {
  let captured: RequestInit | undefined
  const client = new StripeRestClient({
    apiKey: 'rk_test_abcdefghijklmnopqrstuvwxyz123456',
    fetch: async (_input, init) => {
      captured = init
      return new Response(JSON.stringify({
        id: 'cs_test_access123', object: 'checkout.session', url: 'https://checkout.stripe.test/access',
        mode: 'payment', status: 'open', payment_status: 'unpaid', customer: null,
        subscription: null, payment_intent: null, metadata: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await client.createAccessCheckout({
    orderId: 'order-123', accessModel: 'one_time_range', fullPriceUnits: 6, discountedUnits: 2,
    fullPriceId: 'price_full123', discountedPriceId: 'price_discount123', username: 'verifier_01',
    successUrl: 'http://localhost/success', cancelUrl: 'http://localhost/cancel',
    idempotencyKey: 'access_checkout_order-123', environment: 'dev',
  })
  const body = new URLSearchParams(captured?.body as string)
  assert.equal(body.get('mode'), 'payment')
  assert.equal(body.get('line_items[0][price]'), 'price_full123')
  assert.equal(body.get('line_items[0][quantity]'), '6')
  assert.equal(body.get('line_items[1][price]'), 'price_discount123')
  assert.equal(body.get('line_items[1][quantity]'), '2')
  assert.equal(body.get('metadata[billing_kind]'), 'outdock_access')
})

test('raw-body Stripe webhooks are timestamped, signed, mode-bound, and idempotently processed', async () => {
  const timestamp = 1_777_500_000
  const secret = 'whsec_test_webhook_secret_abcdefghijklmnopqrstuvwxyz'
  const body = JSON.stringify({
    id: 'evt_test_123456', object: 'event', type: 'checkout.session.completed',
    api_version: STRIPE_API_VERSION, created: timestamp, livemode: false,
    data: { object: { id: 'cs_test_123456', object: 'checkout.session', payment_status: 'paid', metadata: {} } },
  })
  const signatureHeader = await createStripeSignatureHeader(body, secret, timestamp)
  assert.equal((await verifyStripeWebhook(body, {
    secrets: secret, signatureHeader, nowSeconds: timestamp, expectedApiVersion: STRIPE_API_VERSION,
  })).id, 'evt_test_123456')
  await assert.rejects(() => verifyStripeWebhook(`${body} `, {
    secrets: secret, signatureHeader, nowSeconds: timestamp,
  }), StripeWebhookError)

  const claims = new Set<string>()
  let handled = 0
  const store: StripeWebhookStore = {
    async claim(input: StripeWebhookClaimInput) {
      if (claims.has(input.event.id)) return 'processed'
      claims.add(input.event.id)
      return 'claimed'
    },
    async complete() {},
    async fail() {},
  }
  const options = {
    secrets: secret, signatureHeader, nowSeconds: timestamp, expectedApiVersion: STRIPE_API_VERSION,
    environment: 'dev' as const, store, now: () => new Date(timestamp * 1000),
    handle: async () => { handled += 1 },
  }
  assert.equal((await processStripeWebhook(body, options)).processed, true)
  assert.equal((await processStripeWebhook(body, options)).duplicate, true)
  assert.equal(handled, 1)
})

test('supplier Checkout activation atomically creates one account, organization, and period-bound entitlement', async () => {
  const database = migratedDatabase()
  const createdAt = '2026-08-20T00:00:00.000Z'
  const eventSeconds = Date.parse(createdAt) / 1000
  const periodEnd = eventSeconds + 31 * 86_400
  database.sqlite.prepare(`
    INSERT INTO pending_registrations (
      id, environment, role, username, email, email_normalized, password_hash,
      legal_name, address_line1, city, postal_code, country, initial_mode,
      plan_code, auto_renew, stripe_checkout_session_id, status, expires_at,
      created_at, updated_at
    ) VALUES (?, 'prod', 'supplier', 'alice_01', ?, ?, ?, 'Acme Ltd', '1 Test St',
              'Hong Kong', '000000', 'HK', 'H', 'A', 1, ?, 'checkout_created', ?, ?, ?)
  `).run('pending-1', 'alice@gmail.com', 'alice@gmail.com', 'pbkdf2-placeholder', 'cs_live_supplier1', '2026-08-21T00:00:00.000Z', createdAt, createdAt)
  database.sqlite.prepare(`
    INSERT INTO billing_orders (
      id, environment, order_type, pending_registration_id, plan_code,
      amount_cents, currency, auto_renew, status, stripe_checkout_session_id,
      stripe_price_id, created_at, updated_at
    ) VALUES ('order-1', 'prod', 'supplier_subscription', 'pending-1', 'A',
              9900, 'usd', 1, 'checkout_created', 'cs_live_supplier1',
              'price_supplierA', ?, ?)
  `).run(createdAt, createdAt)
  database.sqlite.prepare(`
    INSERT INTO stripe_webhook_events (
      stripe_event_id, environment, event_type, livemode, api_version,
      payload_hash, status, received_at
    ) VALUES ('evt_live_supplier1', 'prod', 'checkout.session.completed', 1, ?, ?, 'processing', ?)
  `).run(STRIPE_API_VERSION, 'a'.repeat(64), createdAt)

  const handler = createD1BillingEventHandler(database, {
    environment: 'prod',
    now: () => new Date(createdAt),
    stripe: {
      async retrieveSubscription() {
        return {
          id: 'sub_live_supplier1', customerId: 'cus_live_supplier1', status: 'active' as const,
          currentPeriodStart: eventSeconds, currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false, canceledAt: null, priceIds: ['price_supplierA'],
        }
      },
    },
  })
  const event = {
    id: 'evt_live_supplier1', object: 'event' as const, type: 'checkout.session.completed',
    api_version: STRIPE_API_VERSION, created: eventSeconds, livemode: true,
    data: { object: {
      id: 'cs_live_supplier1', object: 'checkout.session', payment_status: 'paid',
      customer: 'cus_live_supplier1', subscription: 'sub_live_supplier1', payment_intent: 'pi_live_supplier1',
      metadata: { billing_kind: 'supplier_subscription', environment: 'prod', pending_registration_id: 'pending-1', plan_code: 'A' },
    } },
  }
  await handler(event)
  await handler(event)
  assert.equal((database.sqlite.prepare(`SELECT count(*) AS count FROM users`).get() as { count: number }).count, 1)
  assert.equal((database.sqlite.prepare(`SELECT count(*) AS count FROM organizations`).get() as { count: number }).count, 1)
  const entitlement = database.sqlite.prepare(`
    SELECT status, valid_until, stripe_subscription_id FROM entitlements
  `).get() as { status: string; valid_until: string; stripe_subscription_id: string }
  assert.equal(entitlement.status, 'active')
  assert.equal(entitlement.valid_until, new Date(periodEnd * 1000).toISOString())
  assert.equal(entitlement.stripe_subscription_id, 'sub_live_supplier1')
})
