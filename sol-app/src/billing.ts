import type { RuntimeEnvironment } from './validation'
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
  requireInteger,
  requirePlainRecord,
  requireString,
  safeErrorMessage,
  sha256Hex,
  timingSafeEqual,
  utf8,
  validateUsername,
  normalizeOptionalGmail,
} from './validation'

export const STRIPE_API_VERSION = '2026-06-24.dahlia'
export const VERIFIER_READ_PASS_DAYS = 30

export type SupplierPlanCode = 'A' | 'B' | 'C' | 'D'

export interface StripeRestConfig {
  /** Prefer a minimally scoped rk_ key stored as a Worker secret. */
  apiKey: string
  fetch?: typeof fetch
  apiBaseUrl?: string
}

export interface SupplierCheckoutInput {
  pendingRegistrationId: string
  planCode: SupplierPlanCode
  priceId: string
  username: string
  customerEmail?: string | null
  successUrl: string
  cancelUrl: string
  idempotencyKey: string
  environment: RuntimeEnvironment
}

export interface VerifierCheckoutInput {
  pendingRegistrationId: string
  scopeId: string
  priceId: string
  username: string
  customerEmail?: string | null
  successUrl: string
  cancelUrl: string
  idempotencyKey: string
  environment: RuntimeEnvironment
}

export interface AccessCheckoutInput {
  orderId: string
  accessModel: 'one_time_range' | 'subscription_28d'
  fullPriceUnits: number
  discountedUnits: number
  fullPriceId?: string
  discountedPriceId?: string
  subscriptionPriceId?: string
  username: string
  customerEmail?: string | null
  successUrl: string
  cancelUrl: string
  idempotencyKey: string
  environment: RuntimeEnvironment
}

export interface StripeCheckoutSession {
  id: string
  object: 'checkout.session'
  url: string | null
  mode: 'payment' | 'subscription' | 'setup'
  status: string | null
  payment_status: string | null
  customer: string | null
  subscription: string | null
  payment_intent: string | null
  metadata: Record<string, string>
}

export interface StripeSubscriptionSnapshot {
  id: string
  customerId: string
  status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused'
  currentPeriodStart: number
  currentPeriodEnd: number
  cancelAtPeriodEnd: boolean
  canceledAt: number | null
  priceIds: string[]
}

export interface BillingPortalSessionInput {
  customerId: string
  returnUrl: string
  environment: RuntimeEnvironment
  idempotencyKey: string
}

export interface BillingPortalSession {
  id: string
  url: string
}

export class StripeApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | null

  constructor(message: string, status: number, code = 'stripe_api_error', requestId: string | null = null) {
    super(message)
    this.name = 'StripeApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

function assertStripeKey(value: string): string {
  const key = requireString(value, 'Stripe API key', { min: 20, max: 512, trim: false })
  if (!/^(?:rk|sk)_(?:test|live)_[A-Za-z0-9_]+$/u.test(key)) {
    throw new StripeApiError('Stripe API key format is invalid', 500, 'stripe_configuration_error')
  }
  return key
}

function assertStripeId(value: string, prefix: string, field: string): string {
  return requireString(value, field, { min: prefix.length + 4, max: 255, pattern: new RegExp(`^${prefix}_[A-Za-z0-9_]+$`, 'u') })
}

function assertCheckoutUrl(value: string, field: string, environment: RuntimeEnvironment): string {
  const output = requireString(value, field, { max: 2048, trim: false })
  let parsed: URL
  try {
    parsed = new URL(output)
  } catch {
    throw new StripeApiError(`${field} must be an absolute URL`, 500, 'stripe_configuration_error')
  }
  if (parsed.protocol !== 'https:' && !(environment === 'dev' && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new StripeApiError(`${field} must use HTTPS`, 500, 'stripe_configuration_error')
  }
  return output
}

function assertEnvironment(value: RuntimeEnvironment): void {
  if (value !== 'dev' && value !== 'prod') throw new StripeApiError('Invalid billing environment', 500, 'stripe_configuration_error')
}

function randomLetters(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  return Array.from(randomBytes(length), (value) => alphabet[value % alphabet.length]).join('')
}

/** Stripe requires an eight-random-letter suffix for Checkout integration labels. */
export function createIntegrationIdentifier(flow: 'supplier' | 'readpass'): string {
  return `outside_docker_${flow}_${randomLetters(8)}`
}

function appendMetadata(parameters: URLSearchParams, prefix: string, metadata: Record<string, string>): void {
  for (const [key, value] of Object.entries(metadata)) {
    requireString(key, 'Stripe metadata key', { max: 40, pattern: /^[A-Za-z0-9_]+$/ })
    parameters.set(`${prefix}[${key}]`, requireString(value, `Stripe metadata ${key}`, { max: 500, trim: false }))
  }
}

function baseCheckoutParameters(input: {
  pendingRegistrationId: string
  username: string
  customerEmail?: string | null
  successUrl: string
  cancelUrl: string
  environment: RuntimeEnvironment
}): URLSearchParams {
  assertEnvironment(input.environment)
  const parameters = new URLSearchParams()
  parameters.set('client_reference_id', requireString(input.pendingRegistrationId, 'pendingRegistrationId', { max: 128 }))
  parameters.set('success_url', assertCheckoutUrl(input.successUrl, 'successUrl', input.environment))
  parameters.set('cancel_url', assertCheckoutUrl(input.cancelUrl, 'cancelUrl', input.environment))
  if (input.customerEmail) parameters.set('customer_email', normalizeOptionalGmail(input.customerEmail) as string)
  // payment_method_types is intentionally absent: Stripe dynamic payment methods are authoritative.
  return parameters
}

function parseStripeSession(value: unknown): StripeCheckoutSession {
  const session = requirePlainRecord(value, 'Stripe Checkout Session')
  if (session.object !== 'checkout.session') throw new StripeApiError('Stripe returned an unexpected object', 502, 'invalid_stripe_response')
  const id = assertStripeId(session.id as string, 'cs', 'Checkout Session ID')
  if (session.mode !== 'payment' && session.mode !== 'subscription' && session.mode !== 'setup') {
    throw new StripeApiError('Stripe returned an invalid Checkout mode', 502, 'invalid_stripe_response')
  }
  const metadataRecord = session.metadata === null ? {} : requirePlainRecord(session.metadata, 'Stripe metadata')
  const metadata: Record<string, string> = {}
  for (const [key, item] of Object.entries(metadataRecord)) {
    if (typeof item === 'string') metadata[key] = item
  }
  return {
    id,
    object: 'checkout.session',
    url: typeof session.url === 'string' ? session.url : null,
    mode: session.mode,
    status: typeof session.status === 'string' ? session.status : null,
    payment_status: typeof session.payment_status === 'string' ? session.payment_status : null,
    customer: typeof session.customer === 'string' ? session.customer : null,
    subscription: typeof session.subscription === 'string' ? session.subscription : null,
    payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    metadata,
  }
}

function subscriptionPeriod(item: Record<string, unknown>, field: 'current_period_start' | 'current_period_end'): number | null {
  const value = item[field]
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null
}

export function parseStripeSubscription(value: unknown): StripeSubscriptionSnapshot {
  const subscription = requirePlainRecord(value, 'Stripe subscription')
  if (subscription.object !== 'subscription') throw new StripeApiError('Stripe returned an unexpected object', 502, 'invalid_stripe_response')
  const status = subscription.status
  if (!['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'].includes(status as string)) {
    throw new StripeApiError('Stripe returned an unsupported subscription status', 502, 'invalid_stripe_response')
  }
  const items = requirePlainRecord(subscription.items, 'Stripe subscription items')
  if (!Array.isArray(items.data) || items.data.length < 1) {
    throw new StripeApiError('Stripe subscription has no billing items', 502, 'invalid_stripe_response')
  }
  const periods = items.data.map((raw) => {
    const item = requirePlainRecord(raw, 'Stripe subscription item')
    const price = requirePlainRecord(item.price, 'Stripe subscription price')
    return {
      start: subscriptionPeriod(item, 'current_period_start'),
      end: subscriptionPeriod(item, 'current_period_end'),
      priceId: assertStripeId(price.id as string, 'price', 'Stripe subscription price ID'),
    }
  })
  const starts = periods.flatMap((item) => item.start === null ? [] : [item.start])
  const ends = periods.flatMap((item) => item.end === null ? [] : [item.end])
  if (starts.length !== periods.length || ends.length !== periods.length) {
    throw new StripeApiError('Stripe subscription period is incomplete', 502, 'invalid_stripe_response')
  }
  // Access is bounded by the earliest paid item period if several items exist.
  const currentPeriodStart = Math.max(...starts)
  const currentPeriodEnd = Math.min(...ends)
  if (currentPeriodEnd <= currentPeriodStart) throw new StripeApiError('Stripe subscription period is invalid', 502, 'invalid_stripe_response')
  return {
    id: assertStripeId(subscription.id as string, 'sub', 'Stripe subscription ID'),
    customerId: assertStripeId(subscription.customer as string, 'cus', 'Stripe customer ID'),
    status: status as StripeSubscriptionSnapshot['status'],
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    canceledAt: subscription.canceled_at === null || subscription.canceled_at === undefined
      ? null
      : requireInteger(subscription.canceled_at, 'Stripe subscription cancellation time', 0),
    priceIds: periods.map((item) => item.priceId),
  }
}

export class StripeRestClient {
  private readonly apiKey: string
  private readonly request: typeof fetch
  private readonly apiBaseUrl: string

  constructor(config: StripeRestConfig) {
    this.apiKey = assertStripeKey(config.apiKey)
    this.request = config.fetch ?? fetch
    const apiBaseUrl = (config.apiBaseUrl ?? 'https://api.stripe.com').replace(/\/$/u, '')
    if (apiBaseUrl !== 'https://api.stripe.com') {
      throw new StripeApiError('Stripe API base URL must be https://api.stripe.com', 500, 'stripe_configuration_error')
    }
    this.apiBaseUrl = apiBaseUrl
  }

  private async postForm(path: string, parameters: URLSearchParams, idempotencyKey: string): Promise<unknown> {
    const key = requireString(idempotencyKey, 'idempotencyKey', {
      min: 16,
      max: 255,
      pattern: /^[A-Za-z0-9:_-]+$/,
    })
    let response: Response
    try {
      response = await this.request(`${this.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': key,
          'Stripe-Version': STRIPE_API_VERSION,
        },
        body: parameters.toString(),
      })
    } catch {
      throw new StripeApiError('Stripe is temporarily unavailable', 503, 'stripe_unavailable')
    }
    const requestId = response.headers.get('request-id')
    const text = (await response.text()).slice(0, 1_048_576)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new StripeApiError('Stripe returned an unreadable response', 502, 'invalid_stripe_response', requestId)
    }
    if (!response.ok) {
      const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
      const error = record.error !== null && typeof record.error === 'object' ? record.error as Record<string, unknown> : {}
      const code = typeof error.code === 'string' ? `stripe_${error.code}` : 'stripe_request_failed'
      // Do not relay Stripe messages: they can contain customer data or implementation details.
      throw new StripeApiError('Stripe could not create the Checkout Session', response.status, code, requestId)
    }
    return body
  }

  private async getJson(path: string): Promise<unknown> {
    let response: Response
    try {
      response = await this.request(`${this.apiBaseUrl}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Stripe-Version': STRIPE_API_VERSION,
        },
      })
    } catch {
      throw new StripeApiError('Stripe is temporarily unavailable', 503, 'stripe_unavailable')
    }
    const requestId = response.headers.get('request-id')
    const text = (await response.text()).slice(0, 1_048_576)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new StripeApiError('Stripe returned an unreadable response', 502, 'invalid_stripe_response', requestId)
    }
    if (!response.ok) throw new StripeApiError('Stripe could not retrieve billing state', response.status, 'stripe_request_failed', requestId)
    return body
  }

  async createSupplierSubscriptionCheckout(input: SupplierCheckoutInput): Promise<StripeCheckoutSession> {
    if (!['A', 'B', 'C', 'D'].includes(input.planCode)) {
      throw new StripeApiError('Unknown supplier plan', 400, 'invalid_supplier_plan')
    }
    const parameters = baseCheckoutParameters(input)
    const metadata = {
      billing_kind: 'supplier_subscription',
      environment: input.environment,
      pending_registration_id: requireString(input.pendingRegistrationId, 'pendingRegistrationId', { max: 128 }),
      plan_code: input.planCode,
      username: validateUsername(input.username),
    }
    parameters.set('mode', 'subscription')
    parameters.set('line_items[0][price]', assertStripeId(input.priceId, 'price', 'supplier price ID'))
    parameters.set('line_items[0][quantity]', '1')
    parameters.set('integration_identifier', createIntegrationIdentifier('supplier'))
    appendMetadata(parameters, 'metadata', metadata)
    appendMetadata(parameters, 'subscription_data[metadata]', metadata)
    return parseStripeSession(await this.postForm('/v1/checkout/sessions', parameters, input.idempotencyKey))
  }

  async createVerifierReadPassCheckout(input: VerifierCheckoutInput): Promise<StripeCheckoutSession> {
    const parameters = baseCheckoutParameters(input)
    const metadata = {
      auto_renew: 'false',
      billing_kind: 'verifier_read_pass',
      duration_days: String(VERIFIER_READ_PASS_DAYS),
      environment: input.environment,
      pending_registration_id: requireString(input.pendingRegistrationId, 'pendingRegistrationId', { max: 128 }),
      scope_id: requireString(input.scopeId, 'scopeId', { max: 128 }),
      username: validateUsername(input.username),
    }
    parameters.set('mode', 'payment')
    parameters.set('line_items[0][price]', assertStripeId(input.priceId, 'price', 'verifier Read Pass price ID'))
    parameters.set('line_items[0][quantity]', '1')
    parameters.set('integration_identifier', createIntegrationIdentifier('readpass'))
    appendMetadata(parameters, 'metadata', metadata)
    appendMetadata(parameters, 'payment_intent_data[metadata]', metadata)
    return parseStripeSession(await this.postForm('/v1/checkout/sessions', parameters, input.idempotencyKey))
  }

  async createAccessCheckout(input: AccessCheckoutInput): Promise<StripeCheckoutSession> {
    const parameters = baseCheckoutParameters({
      pendingRegistrationId: input.orderId,
      username: input.username,
      customerEmail: input.customerEmail,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      environment: input.environment,
    })
    const metadata = {
      billing_kind: 'outdock_access',
      environment: input.environment,
      access_order_id: requireString(input.orderId, 'access order ID', { max: 128 }),
      access_model: input.accessModel,
      username: validateUsername(input.username),
    }
    if (input.accessModel === 'subscription_28d') {
      parameters.set('mode', 'subscription')
      parameters.set('line_items[0][price]', assertStripeId(input.subscriptionPriceId as string, 'price', 'subscription price ID'))
      parameters.set('line_items[0][quantity]', '1')
      appendMetadata(parameters, 'subscription_data[metadata]', metadata)
    } else {
      if (!Number.isSafeInteger(input.fullPriceUnits) || input.fullPriceUnits < 0 || !Number.isSafeInteger(input.discountedUnits) || input.discountedUnits < 0 || input.fullPriceUnits + input.discountedUnits < 1) {
        throw new StripeApiError('Access quantities are invalid', 400, 'invalid_access_quantity')
      }
      parameters.set('mode', 'payment')
      let line = 0
      if (input.fullPriceUnits > 0) {
        parameters.set(`line_items[${line}][price]`, assertStripeId(input.fullPriceId as string, 'price', 'seven-day price ID'))
        parameters.set(`line_items[${line}][quantity]`, String(input.fullPriceUnits))
        line += 1
      }
      if (input.discountedUnits > 0) {
        parameters.set(`line_items[${line}][price]`, assertStripeId(input.discountedPriceId as string, 'price', 'discounted seven-day price ID'))
        parameters.set(`line_items[${line}][quantity]`, String(input.discountedUnits))
      }
      appendMetadata(parameters, 'payment_intent_data[metadata]', metadata)
    }
    parameters.set('integration_identifier', createIntegrationIdentifier('readpass'))
    appendMetadata(parameters, 'metadata', metadata)
    return parseStripeSession(await this.postForm('/v1/checkout/sessions', parameters, input.idempotencyKey))
  }

  /** Requires read access to Subscriptions on the restricted Stripe key. */
  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionSnapshot> {
    const id = assertStripeId(subscriptionId, 'sub', 'Stripe subscription ID')
    return parseStripeSubscription(await this.getJson(`/v1/subscriptions/${encodeURIComponent(id)}`))
  }

  /** Stripe-hosted self-service management; requires Billing Portal Session write access. */
  async createBillingPortalSession(input: BillingPortalSessionInput): Promise<BillingPortalSession> {
    assertEnvironment(input.environment)
    const parameters = new URLSearchParams({
      customer: assertStripeId(input.customerId, 'cus', 'Stripe customer ID'),
      return_url: assertCheckoutUrl(input.returnUrl, 'returnUrl', input.environment),
    })
    const body = requirePlainRecord(
      await this.postForm('/v1/billing_portal/sessions', parameters, input.idempotencyKey),
      'Stripe Billing Portal Session',
    )
    if (body.object !== 'billing_portal.session') throw new StripeApiError('Stripe returned an unexpected object', 502, 'invalid_stripe_response')
    return {
      id: assertStripeId(body.id as string, 'bps', 'Billing Portal Session ID'),
      url: requireString(body.url, 'Billing Portal URL', { max: 2048, pattern: /^https:\/\//, trim: false }),
    }
  }
}

export interface StripeEvent {
  id: string
  object: 'event'
  type: string
  api_version: string | null
  created: number
  livemode: boolean
  data: { object: Record<string, unknown> }
}

export class StripeWebhookError extends Error {
  readonly status = 400
  readonly code: string

  constructor(message: string, code = 'invalid_stripe_webhook') {
    super(message)
    this.name = 'StripeWebhookError'
    this.code = code
  }
}

function webhookBodyBytes(body: string | Uint8Array): Uint8Array {
  const output = typeof body === 'string' ? utf8(body) : body
  if (!(output instanceof Uint8Array) || output.length === 0 || output.length > 2_097_152) {
    throw new StripeWebhookError('Webhook body is invalid', 'invalid_webhook_body')
  }
  return output
}

function parseSignatureHeader(header: string): { timestamp: number; signatures: Uint8Array[] } {
  if (typeof header !== 'string' || header.length < 10 || header.length > 8192) {
    throw new StripeWebhookError('Stripe-Signature header is invalid', 'invalid_webhook_signature')
  }
  const timestamps: number[] = []
  const signatures: Uint8Array[] = []
  for (const component of header.split(',')) {
    const separator = component.indexOf('=')
    if (separator < 1) continue
    const key = component.slice(0, separator).trim()
    const value = component.slice(separator + 1).trim()
    if (key === 't' && /^\d{9,12}$/.test(value)) timestamps.push(Number(value))
    if (key === 'v1' && /^[0-9a-fA-F]{64}$/.test(value)) signatures.push(hexToBytes(value, 32))
  }
  if (timestamps.length !== 1 || !Number.isSafeInteger(timestamps[0]) || signatures.length === 0) {
    throw new StripeWebhookError('Stripe-Signature header is invalid', 'invalid_webhook_signature')
  }
  return { timestamp: timestamps[0], signatures }
}

async function stripeWebhookMac(secret: string, timestamp: number, body: Uint8Array): Promise<Uint8Array> {
  const normalizedSecret = requireString(secret, 'Stripe webhook secret', { min: 16, max: 512, trim: false })
  if (!normalizedSecret.startsWith('whsec_')) throw new StripeWebhookError('Stripe webhook secret is not configured', 'webhook_configuration_error')
  const prefix = utf8(`${timestamp}.`)
  const signedPayload = new Uint8Array(prefix.length + body.length)
  signedPayload.set(prefix)
  signedPayload.set(body, prefix.length)
  const key = await crypto.subtle.importKey('raw', utf8(normalizedSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, signedPayload))
}

function parseStripeEvent(body: Uint8Array): StripeEvent {
  let event: Record<string, unknown>
  try {
    event = requirePlainRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)), 'Stripe event')
  } catch {
    throw new StripeWebhookError('Stripe event JSON is invalid', 'invalid_webhook_payload')
  }
  const data = requirePlainRecord(event.data, 'Stripe event data')
  const object = requirePlainRecord(data.object, 'Stripe event object')
  const id = assertStripeId(event.id as string, 'evt', 'Stripe event ID')
  if (event.object !== 'event' || typeof event.livemode !== 'boolean') {
    throw new StripeWebhookError('Stripe event envelope is invalid', 'invalid_webhook_payload')
  }
  return {
    id,
    object: 'event',
    type: requireString(event.type, 'Stripe event type', { max: 128, pattern: /^[a-z0-9_.]+$/ }),
    api_version: event.api_version === null ? null : requireString(event.api_version, 'Stripe API version', { max: 64 }),
    created: requireInteger(event.created, 'Stripe event created', 0),
    livemode: event.livemode,
    data: { object },
  }
}

export interface StripeWebhookVerificationOptions {
  secrets: string | readonly string[]
  signatureHeader: string
  toleranceSeconds?: number
  nowSeconds?: number
  expectedApiVersion?: string | null
}

/** Signature is checked against the exact raw request body before JSON parsing. */
export async function verifyStripeWebhook(
  rawBody: string | Uint8Array,
  options: StripeWebhookVerificationOptions,
): Promise<StripeEvent> {
  const body = webhookBodyBytes(rawBody)
  const parsed = parseSignatureHeader(options.signatureHeader)
  const current = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = requireInteger(options.toleranceSeconds ?? 300, 'Stripe webhook tolerance', 1, 900)
  if (!Number.isSafeInteger(current) || Math.abs(current - parsed.timestamp) > tolerance) {
    throw new StripeWebhookError('Stripe webhook timestamp is outside the allowed tolerance', 'webhook_timestamp_outside_tolerance')
  }
  const secrets = typeof options.secrets === 'string' ? [options.secrets] : [...options.secrets]
  if (secrets.length < 1 || secrets.length > 3) throw new StripeWebhookError('Stripe webhook secret is not configured', 'webhook_configuration_error')
  let verified = false
  for (const secret of secrets) {
    const expected = await stripeWebhookMac(secret, parsed.timestamp, body)
    for (const signature of parsed.signatures) verified = timingSafeEqual(expected, signature) || verified
  }
  if (!verified) throw new StripeWebhookError('Stripe webhook signature is invalid', 'invalid_webhook_signature')
  const event = parseStripeEvent(body)
  const expectedApiVersion = options.expectedApiVersion === undefined ? STRIPE_API_VERSION : options.expectedApiVersion
  if (expectedApiVersion && event.api_version !== expectedApiVersion) {
    throw new StripeWebhookError('Stripe webhook API version is unsupported', 'unsupported_webhook_api_version')
  }
  return event
}

export type StripeWebhookClaim = 'claimed' | 'processed' | 'processing'

export interface StripeWebhookClaimInput {
  event: StripeEvent
  environment: RuntimeEnvironment
  payloadHash: string
  objectId: string | null
  receivedAt: string
}

export interface StripeWebhookStore {
  claim(input: StripeWebhookClaimInput): Promise<StripeWebhookClaim>
  complete(eventId: string, processedAt: string): Promise<void>
  fail(eventId: string, failedAt: string, error: string): Promise<void>
}

export interface StripeWebhookHandler {
  (event: StripeEvent): Promise<void>
}

export interface ProcessStripeWebhookOptions extends StripeWebhookVerificationOptions {
  environment: RuntimeEnvironment
  store: StripeWebhookStore
  handle: StripeWebhookHandler
  now?: () => Date
}

export interface ProcessStripeWebhookResult {
  eventId: string
  eventType: string
  processed: boolean
  duplicate: boolean
}

function eventObjectId(event: StripeEvent): string | null {
  return typeof event.data.object.id === 'string' ? event.data.object.id.slice(0, 255) : null
}

export async function processStripeWebhook(
  rawBody: string | Uint8Array,
  options: ProcessStripeWebhookOptions,
): Promise<ProcessStripeWebhookResult> {
  assertEnvironment(options.environment)
  const event = await verifyStripeWebhook(rawBody, options)
  if (event.livemode !== (options.environment === 'prod')) {
    throw new StripeWebhookError('Stripe event mode does not match this environment', 'webhook_environment_mismatch')
  }
  const body = webhookBodyBytes(rawBody)
  const now = options.now?.() ?? new Date()
  const receivedAt = now.toISOString()
  const claim = await options.store.claim({
    event,
    environment: options.environment,
    payloadHash: await sha256Hex(body),
    objectId: eventObjectId(event),
    receivedAt,
  })
  if (claim !== 'claimed') {
    return { eventId: event.id, eventType: event.type, processed: claim === 'processed', duplicate: true }
  }
  try {
    await options.handle(event)
    await options.store.complete(event.id, (options.now?.() ?? new Date()).toISOString())
    return { eventId: event.id, eventType: event.type, processed: true, duplicate: false }
  } catch (error) {
    await options.store.fail(event.id, (options.now?.() ?? new Date()).toISOString(), safeErrorMessage(error))
    throw error
  }
}

export interface D1RunResultLike {
  success?: boolean
  meta?: { changes?: number }
}

export interface D1WebhookStatementLike {
  bind(...values: unknown[]): D1WebhookStatementLike
  run(): Promise<D1RunResultLike>
  first<T = Record<string, unknown>>(): Promise<T | null>
}

export interface D1WebhookDatabaseLike {
  prepare(query: string): D1WebhookStatementLike
}

interface StoredWebhookRow {
  status: 'received' | 'processing' | 'processed' | 'failed'
  payload_hash: string
}

/** D1-backed atomic event claim. A stale processing claim can be retried safely. */
export function createD1StripeWebhookStore(
  database: D1WebhookDatabaseLike,
  options: { staleAfterSeconds?: number } = {},
): StripeWebhookStore {
  const staleAfterSeconds = requireInteger(options.staleAfterSeconds ?? 300, 'stale webhook seconds', 30, 3600)
  return {
    async claim(input) {
      await database.prepare(`
        INSERT OR IGNORE INTO stripe_webhook_events (
          stripe_event_id, environment, event_type, object_id, livemode, api_version,
          payload_hash, status, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?)
      `).bind(
        input.event.id,
        input.environment,
        input.event.type,
        input.objectId,
        input.event.livemode ? 1 : 0,
        input.event.api_version,
        input.payloadHash,
        input.receivedAt,
      ).run()

      const staleBefore = new Date(Date.parse(input.receivedAt) - staleAfterSeconds * 1000).toISOString()
      const updated = await database.prepare(`
        UPDATE stripe_webhook_events SET
          status = 'processing',
          processing_started_at = ?,
          attempt_count = attempt_count + 1,
          last_error = NULL
        WHERE stripe_event_id = ? AND payload_hash = ? AND (
          status IN ('received', 'failed') OR
          (status = 'processing' AND processing_started_at < ?)
        )
      `).bind(input.receivedAt, input.event.id, input.payloadHash, staleBefore).run()
      if ((updated.meta?.changes ?? 0) === 1) return 'claimed'

      const row = await database.prepare(`
        SELECT status, payload_hash FROM stripe_webhook_events WHERE stripe_event_id = ? LIMIT 1
      `).bind(input.event.id).first<StoredWebhookRow>()
      if (!row || row.payload_hash !== input.payloadHash) {
        throw new StripeWebhookError('Stripe event ID was reused with different content', 'webhook_event_conflict')
      }
      return row.status === 'processed' ? 'processed' : 'processing'
    },
    async complete(eventId, processedAt) {
      const result = await database.prepare(`
        UPDATE stripe_webhook_events SET
          status = 'processed', processed_at = ?, last_error = NULL
        WHERE stripe_event_id = ? AND status = 'processing'
      `).bind(processedAt, eventId).run()
      if ((result.meta?.changes ?? 0) !== 1) throw new StripeWebhookError('Stripe event claim was lost', 'webhook_claim_lost')
    },
    async fail(eventId, _failedAt, error) {
      await database.prepare(`
        UPDATE stripe_webhook_events SET status = 'failed', last_error = ?
        WHERE stripe_event_id = ? AND status = 'processing'
      `).bind(error.slice(0, 500), eventId).run()
    },
  }
}

export type CheckoutBillingKind = 'supplier_subscription' | 'verifier_read_pass'

export interface CheckoutActivation {
  kind: CheckoutBillingKind
  pendingRegistrationId: string
  environment: RuntimeEnvironment
  sessionId: string
  customerId: string | null
  subscriptionId: string | null
  paymentIntentId: string | null
  planCode: SupplierPlanCode | null
  scopeId: string | null
}

/** Extract only successful Checkout activations; other event types return null. */
export function checkoutActivationFromEvent(event: StripeEvent): CheckoutActivation | null {
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return null
  const session = event.data.object
  if (session.object !== 'checkout.session') return null
  const paymentStatus = typeof session.payment_status === 'string' ? session.payment_status : null
  if (paymentStatus !== 'paid') return null
  const metadata = requirePlainRecord(session.metadata, 'Checkout metadata')
  if (metadata.billing_kind !== 'supplier_subscription' && metadata.billing_kind !== 'verifier_read_pass') return null
  const environment = metadata.environment
  if (environment !== 'dev' && environment !== 'prod') throw new StripeWebhookError('Checkout metadata environment is invalid', 'invalid_checkout_metadata')
  const kind = metadata.billing_kind
  const planCode = kind === 'supplier_subscription' ? metadata.plan_code : null
  if (planCode !== null && !['A', 'B', 'C', 'D'].includes(planCode as string)) {
    throw new StripeWebhookError('Checkout supplier plan is invalid', 'invalid_checkout_metadata')
  }
  return {
    kind,
    pendingRegistrationId: requireString(metadata.pending_registration_id, 'pending registration ID', { max: 128 }),
    environment,
    sessionId: assertStripeId(session.id as string, 'cs', 'Checkout Session ID'),
    customerId: typeof session.customer === 'string' ? assertStripeId(session.customer, 'cus', 'Stripe customer ID') : null,
    subscriptionId: typeof session.subscription === 'string' ? assertStripeId(session.subscription, 'sub', 'Stripe subscription ID') : null,
    paymentIntentId: typeof session.payment_intent === 'string' ? assertStripeId(session.payment_intent, 'pi', 'Stripe PaymentIntent ID') : null,
    planCode: planCode as SupplierPlanCode | null,
    scopeId: kind === 'verifier_read_pass' ? requireString(metadata.scope_id, 'scope ID', { max: 128 }) : null,
  }
}

export interface D1BillingDatabaseLike<TStatement extends D1WebhookStatementLike = D1WebhookStatementLike> {
  prepare(query: string): TStatement
  batch(statements: TStatement[]): Promise<unknown>
}

export interface D1BillingEventHandlerOptions {
  environment: RuntimeEnvironment
  stripe: Pick<StripeRestClient, 'retrieveSubscription'>
  now?: () => Date
}

interface PendingActivationRow {
  pending_id: string
  pending_status: string
  role: 'supplier' | 'verifier'
  username: string
  email: string | null
  email_normalized: string | null
  email_verified_at: string | null
  password_hash: string
  legal_name: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
  initial_mode: string | null
  plan_code: SupplierPlanCode | null
  verifier_scope_id: string | null
  pending_checkout_id: string | null
  activated_user_id: string | null
  order_id: string
  order_type: CheckoutBillingKind
  order_status: string
  order_scope_id: string | null
  order_plan_code: SupplierPlanCode | null
  amount_cents: number
  order_checkout_id: string | null
  stripe_price_id: string | null
  write_rate_per_minute: number | null
  records_per_write: number | null
}

interface EntitlementSubscriptionRow {
  entitlement_id: string
  billing_order_id: string | null
  stripe_price_id: string | null
}

function eventTimeIso(event: StripeEvent): string {
  return new Date(event.created * 1000).toISOString()
}

function epochIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

function subscriptionInternalStatus(status: StripeSubscriptionSnapshot['status']): string {
  return status === 'incomplete_expired' ? 'expired' : status
}

function subscriptionObjectId(value: unknown): string | null {
  if (typeof value === 'string' && /^sub_[A-Za-z0-9_]+$/u.test(value)) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id
    if (typeof id === 'string' && /^sub_[A-Za-z0-9_]+$/u.test(id)) return id
  }
  return null
}

function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const direct = subscriptionObjectId(invoice.subscription)
  if (direct) return direct
  if (invoice.parent && typeof invoice.parent === 'object' && !Array.isArray(invoice.parent)) {
    const details = (invoice.parent as Record<string, unknown>).subscription_details
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      const nested = subscriptionObjectId((details as Record<string, unknown>).subscription)
      if (nested) return nested
    }
  }
  return null
}

/**
 * Creates the production billing lifecycle handler used inside
 * `processStripeWebhook`. Checkout fulfillment is one D1 batch and all replay
 * paths are conditional, so a second successful Stripe event cannot create a
 * second account, entitlement, or 30-day extension.
 */
export function createD1BillingEventHandler<TStatement extends D1WebhookStatementLike>(
  database: D1BillingDatabaseLike<TStatement>,
  options: D1BillingEventHandlerOptions,
): StripeWebhookHandler {
  assertEnvironment(options.environment)
  const statement = (sql: string, ...values: unknown[]): TStatement => database.prepare(sql).bind(...values) as TStatement

  async function pendingActivation(pendingId: string): Promise<PendingActivationRow | null> {
    return database.prepare(`
      SELECT
        p.id AS pending_id, p.status AS pending_status, p.role, p.username,
        p.email, p.email_normalized, p.email_verified_at, p.password_hash,
        p.legal_name, p.address_line1, p.address_line2, p.city, p.region,
        p.postal_code, p.country, p.initial_mode, p.plan_code,
        p.verifier_scope_id, p.stripe_checkout_session_id AS pending_checkout_id,
        p.activated_user_id,
        o.id AS order_id, o.order_type, o.status AS order_status,
        o.scope_id AS order_scope_id, o.plan_code AS order_plan_code,
        o.amount_cents, o.stripe_checkout_session_id AS order_checkout_id,
        o.stripe_price_id,
        bp.write_rate_per_minute, bp.records_per_write
      FROM pending_registrations p
      JOIN billing_orders o ON o.pending_registration_id = p.id
      LEFT JOIN billing_plans bp ON bp.code = p.plan_code
      WHERE p.id = ? AND p.environment = ? AND o.environment = ?
      ORDER BY o.created_at ASC LIMIT 1
    `).bind(pendingId, options.environment, options.environment).first<PendingActivationRow>()
  }

  async function activateCheckout(event: StripeEvent, activation: CheckoutActivation): Promise<void> {
    if (activation.environment !== options.environment) {
      throw new StripeWebhookError('Checkout environment metadata does not match', 'checkout_environment_mismatch')
    }
    const row = await pendingActivation(activation.pendingRegistrationId)
    if (!row) throw new StripeWebhookError('Pending registration was not found', 'pending_registration_not_found')
    if (row.pending_status === 'completed' && row.activated_user_id && row.order_status === 'fulfilled') return
    if (
      row.pending_checkout_id !== activation.sessionId
      || row.order_checkout_id !== activation.sessionId
      || row.order_type !== activation.kind
      || !['checkout_created', 'paid'].includes(row.pending_status)
      || !['checkout_created', 'paid'].includes(row.order_status)
    ) throw new StripeWebhookError('Checkout does not match the pending billing order', 'checkout_order_mismatch')

    const supplier = activation.kind === 'supplier_subscription'
    if (supplier) {
      if (row.role !== 'supplier' || row.plan_code !== activation.planCode || row.order_plan_code !== activation.planCode) {
        throw new StripeWebhookError('Supplier Checkout metadata does not match the order', 'checkout_order_mismatch')
      }
      if (!activation.subscriptionId || !activation.customerId || !row.stripe_price_id) {
        throw new StripeWebhookError('Supplier Checkout is missing subscription state', 'checkout_subscription_missing')
      }
    } else if (
      row.role !== 'verifier'
      || row.verifier_scope_id !== activation.scopeId
      || row.order_scope_id !== activation.scopeId
      || row.amount_cents !== 2_900
      || !activation.paymentIntentId
    ) throw new StripeWebhookError('Verifier Checkout metadata does not match the order', 'checkout_order_mismatch')

    let subscription: StripeSubscriptionSnapshot | null = null
    if (supplier) {
      subscription = await options.stripe.retrieveSubscription(activation.subscriptionId as string)
      if (
        !['active', 'trialing'].includes(subscription.status)
        || subscription.currentPeriodEnd * 1000 <= (options.now?.() ?? new Date()).valueOf()
        || subscription.customerId !== activation.customerId
        || !subscription.priceIds.includes(row.stripe_price_id as string)
      ) throw new StripeWebhookError('Stripe subscription is not active for the ordered price', 'subscription_not_active')
    }

    const userId = crypto.randomUUID()
    const organizationId = crypto.randomUUID()
    const entitlementId = crypto.randomUUID()
    const processedAt = (options.now?.() ?? new Date()).toISOString()
    const paidAt = eventTimeIso(event)
    const validFrom = supplier ? epochIso((subscription as StripeSubscriptionSnapshot).currentPeriodStart) : paidAt
    const validUntil = supplier
      ? epochIso((subscription as StripeSubscriptionSnapshot).currentPeriodEnd)
      : new Date(event.created * 1000 + VERIFIER_READ_PASS_DAYS * 86_400_000).toISOString()
    const entitlementStatus = supplier ? subscriptionInternalStatus((subscription as StripeSubscriptionSnapshot).status) : 'active'
    const customerId = activation.customerId
    const subscriptionId = activation.subscriptionId
    const paymentIntentId = activation.paymentIntentId

    const orderPredicate = `
      EXISTS (
        SELECT 1 FROM billing_orders o
        WHERE o.id = ? AND o.pending_registration_id = p.id
          AND o.status IN ('checkout_created', 'paid')
          AND o.stripe_checkout_session_id = ?
      )
    `
    const statements: TStatement[] = [
      statement(`
        UPDATE pending_registrations SET
          status = 'paid', stripe_customer_id = ?, stripe_subscription_id = ?,
          stripe_payment_intent_id = ?, updated_at = ?
        WHERE id = ? AND environment = ? AND status IN ('checkout_created', 'paid')
          AND stripe_checkout_session_id = ?
          AND EXISTS (
            SELECT 1 FROM billing_orders WHERE id = ? AND status IN ('checkout_created', 'paid')
              AND stripe_checkout_session_id = ?
          )
      `, customerId, subscriptionId, paymentIntentId, processedAt,
      row.pending_id, options.environment, activation.sessionId, row.order_id, activation.sessionId),
      statement(`
        INSERT INTO users (
          id, username, email, email_normalized, email_verified_at, password_hash,
          role, totp_enabled, totp_required, session_version, is_active,
          stripe_customer_id, created_at, updated_at
        )
        SELECT ?, p.username, p.email, p.email_normalized, p.email_verified_at,
               p.password_hash, p.role, 0, 0, 1, 1, ?, ?, ?
        FROM pending_registrations p
        WHERE p.id = ? AND p.environment = ? AND p.status = 'paid'
          AND p.activated_user_id IS NULL AND ${orderPredicate}
      `, userId, customerId, processedAt, processedAt,
      row.pending_id, options.environment, row.order_id, activation.sessionId),
    ]

    if (supplier) {
      statements.push(statement(`
        INSERT INTO organizations (
          id, user_id, legal_name, address_line1, address_line2, city, region,
          postal_code, country, initial_mode, billing_email, created_at, updated_at
        )
        SELECT ?, ?, p.legal_name, p.address_line1, p.address_line2, p.city,
               p.region, p.postal_code, p.country, p.initial_mode,
               p.email_normalized, ?, ?
        FROM pending_registrations p
        WHERE p.id = ? AND p.environment = ? AND p.status = 'paid'
          AND p.activated_user_id IS NULL AND p.role = 'supplier' AND ${orderPredicate}
      `, organizationId, userId, processedAt, processedAt,
      row.pending_id, options.environment, row.order_id, activation.sessionId))
      statements.push(statement(`
        INSERT INTO entitlements (
          id, user_id, kind, scope_id, status, valid_from, valid_until, auto_renew,
          environment, plan_code, billing_order_id, stripe_customer_id,
          stripe_subscription_id, stripe_checkout_session_id,
          stripe_payment_intent_id, stripe_price_id, payment_status,
          write_rate_per_minute, records_per_write, created_at, updated_at
        )
        SELECT ?, ?, 'writer_plan', NULL, ?, ?, ?, 1, ?, p.plan_code, ?, ?, ?, ?, ?,
               o.stripe_price_id, 'paid', bp.write_rate_per_minute,
               bp.records_per_write, ?, ?
        FROM pending_registrations p
        JOIN billing_orders o ON o.id = ? AND o.pending_registration_id = p.id
        JOIN billing_plans bp ON bp.code = p.plan_code AND bp.audience = 'supplier' AND bp.is_active = 1
        WHERE p.id = ? AND p.environment = ? AND p.status = 'paid'
          AND p.activated_user_id IS NULL AND o.status IN ('checkout_created', 'paid')
          AND o.stripe_checkout_session_id = ?
      `, entitlementId, userId, entitlementStatus, validFrom, validUntil,
      options.environment, row.order_id, customerId, subscriptionId,
      activation.sessionId, paymentIntentId, processedAt, processedAt,
      row.order_id, row.pending_id, options.environment, activation.sessionId))
    } else {
      statements.push(statement(`
        INSERT INTO entitlements (
          id, user_id, kind, scope_id, status, valid_from, valid_until, auto_renew,
          environment, plan_code, billing_order_id, stripe_customer_id,
          stripe_checkout_session_id, stripe_payment_intent_id, stripe_price_id,
          payment_status, created_at, updated_at
        )
        SELECT ?, ?, 'read_pass', p.verifier_scope_id, 'active', ?, ?, 0, ?,
               'VERIFIER_30D', ?, ?, ?, ?, o.stripe_price_id, 'paid', ?, ?
        FROM pending_registrations p
        JOIN billing_orders o ON o.id = ? AND o.pending_registration_id = p.id
        JOIN billing_plans bp ON bp.code = 'VERIFIER_30D' AND bp.price_cents = 2900 AND bp.access_days = 30 AND bp.is_active = 1
        WHERE p.id = ? AND p.environment = ? AND p.status = 'paid'
          AND p.activated_user_id IS NULL AND p.role = 'verifier'
          AND o.status IN ('checkout_created', 'paid')
          AND o.order_type = 'verifier_read_pass' AND o.amount_cents = 2900
          AND o.scope_id = p.verifier_scope_id AND o.stripe_checkout_session_id = ?
      `, entitlementId, userId, validFrom, validUntil, options.environment,
      row.order_id, customerId, activation.sessionId, paymentIntentId,
      processedAt, processedAt, row.order_id, row.pending_id,
      options.environment, activation.sessionId))
    }

    statements.push(
      statement(`
        UPDATE billing_orders SET
          user_id = ?, status = 'fulfilled', stripe_customer_id = ?,
          stripe_subscription_id = ?, stripe_payment_intent_id = ?,
          entitlement_id = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND pending_registration_id = ?
          AND status IN ('checkout_created', 'paid')
          AND stripe_checkout_session_id = ?
          AND EXISTS (SELECT 1 FROM entitlements WHERE id = ? AND user_id = ?)
      `, userId, customerId, subscriptionId, paymentIntentId,
      entitlementId, processedAt, processedAt, row.order_id, row.pending_id,
      activation.sessionId, entitlementId, userId),
      statement(`
        UPDATE pending_registrations SET
          activated_user_id = ?, status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ? AND environment = ? AND status = 'paid'
          AND activated_user_id IS NULL
          AND EXISTS (
            SELECT 1 FROM billing_orders
            WHERE id = ? AND user_id = ? AND entitlement_id = ? AND status = 'fulfilled'
          )
      `, userId, processedAt, processedAt, row.pending_id, options.environment,
      row.order_id, userId, entitlementId),
      statement(`
        UPDATE stripe_webhook_events SET billing_order_id = ?, pending_registration_id = ?
        WHERE stripe_event_id = ?
      `, row.order_id, row.pending_id, event.id),
    )
    await database.batch(statements)
    const completed = await database.prepare(`
      SELECT activated_user_id FROM pending_registrations
      WHERE id = ? AND status = 'completed' AND activated_user_id IS NOT NULL LIMIT 1
    `).bind(row.pending_id).first<{ activated_user_id: string }>()
    if (!completed) throw new StripeWebhookError('Checkout activation did not complete atomically', 'activation_incomplete')
  }

  async function applySubscription(event: StripeEvent, snapshot: StripeSubscriptionSnapshot): Promise<void> {
    const row = await database.prepare(`
      SELECT id AS entitlement_id, billing_order_id, stripe_price_id
      FROM entitlements WHERE environment = ? AND kind = 'writer_plan'
        AND stripe_subscription_id = ? LIMIT 1
    `).bind(options.environment, snapshot.id).first<EntitlementSubscriptionRow>()
    if (!row) return // A Checkout activation arriving later retrieves the same state.
    if (row.stripe_price_id && !snapshot.priceIds.includes(row.stripe_price_id)) {
      throw new StripeWebhookError('Subscription price no longer matches the entitlement', 'subscription_price_mismatch')
    }
    const processedAt = (options.now?.() ?? new Date()).toISOString()
    const status = subscriptionInternalStatus(snapshot.status)
    const canceled = status === 'canceled' || status === 'expired'
    const failed = ['unpaid', 'past_due', 'incomplete', 'expired', 'paused'].includes(status)
    const validUntil = canceled ? processedAt : epochIso(snapshot.currentPeriodEnd)
    await database.batch([
      statement(`
        UPDATE entitlements SET status = ?, payment_status = ?, valid_from = ?,
          valid_until = ?, auto_renew = ?, canceled_at = ?, updated_at = ?
        WHERE id = ? AND stripe_subscription_id = ?
      `, status, failed ? status : 'paid', epochIso(snapshot.currentPeriodStart),
      validUntil, snapshot.cancelAtPeriodEnd ? 0 : 1,
      canceled ? (snapshot.canceledAt ? epochIso(snapshot.canceledAt) : processedAt) : null,
      processedAt, row.entitlement_id, snapshot.id),
      statement(`
        UPDATE billing_orders SET status = ?, updated_at = ?
        WHERE id = ? AND stripe_subscription_id = ?
      `, canceled ? 'cancelled' : failed ? 'failed' : 'fulfilled', processedAt,
      row.billing_order_id, snapshot.id),
      statement(`
        UPDATE stripe_webhook_events SET billing_order_id = ? WHERE stripe_event_id = ?
      `, row.billing_order_id, event.id),
    ])
  }

  async function markCheckoutFailure(event: StripeEvent, status: 'failed' | 'expired'): Promise<void> {
    const session = event.data.object
    if (session.object !== 'checkout.session' || typeof session.id !== 'string') return
    const sessionId = assertStripeId(session.id, 'cs', 'Checkout Session ID')
    const processedAt = (options.now?.() ?? new Date()).toISOString()
    await database.batch([
      statement(`
        UPDATE pending_registrations SET status = ?, updated_at = ?
        WHERE environment = ? AND stripe_checkout_session_id = ?
          AND status IN ('pending', 'checkout_created')
      `, status, processedAt, options.environment, sessionId),
      statement(`
        UPDATE billing_orders SET status = ?, updated_at = ?
        WHERE environment = ? AND stripe_checkout_session_id = ?
          AND status IN ('pending', 'checkout_created')
      `, status, processedAt, options.environment, sessionId),
      statement(`
        UPDATE stripe_webhook_events SET
          billing_order_id = (SELECT id FROM billing_orders WHERE environment = ? AND stripe_checkout_session_id = ? LIMIT 1),
          pending_registration_id = (SELECT id FROM pending_registrations WHERE environment = ? AND stripe_checkout_session_id = ? LIMIT 1)
        WHERE stripe_event_id = ?
      `, options.environment, sessionId, options.environment, sessionId, event.id),
    ])
  }

  async function markRefund(event: StripeEvent): Promise<void> {
    const charge = event.data.object
    if (event.type !== 'charge.refunded' || charge.refunded !== true || typeof charge.payment_intent !== 'string') return
    const paymentIntentId = assertStripeId(charge.payment_intent, 'pi', 'Stripe PaymentIntent ID')
    const processedAt = (options.now?.() ?? new Date()).toISOString()
    await database.batch([
      statement(`
        UPDATE entitlements SET status = 'refunded', payment_status = 'refunded',
          valid_until = ?, canceled_at = ?, updated_at = ?
        WHERE environment = ? AND stripe_payment_intent_id = ?
      `, processedAt, processedAt, processedAt, options.environment, paymentIntentId),
      statement(`
        UPDATE billing_orders SET status = 'refunded', updated_at = ?
        WHERE environment = ? AND stripe_payment_intent_id = ?
      `, processedAt, options.environment, paymentIntentId),
      statement(`
        UPDATE stripe_webhook_events SET
          billing_order_id = (SELECT id FROM billing_orders WHERE environment = ? AND stripe_payment_intent_id = ? LIMIT 1)
        WHERE stripe_event_id = ?
      `, options.environment, paymentIntentId, event.id),
    ])
  }

  return async (event) => {
    const activation = checkoutActivationFromEvent(event)
    if (activation) {
      await activateCheckout(event, activation)
      return
    }
    if (event.type === 'checkout.session.expired') {
      await markCheckoutFailure(event, 'expired')
      return
    }
    if (event.type === 'checkout.session.async_payment_failed') {
      await markCheckoutFailure(event, 'failed')
      return
    }
    if (event.type.startsWith('customer.subscription.')) {
      await applySubscription(event, parseStripeSubscription(event.data.object))
      return
    }
    if (event.type.startsWith('invoice.')) {
      const subscriptionId = invoiceSubscriptionId(event.data.object)
      if (!subscriptionId) return
      const snapshot = await options.stripe.retrieveSubscription(subscriptionId)
      await applySubscription(event, snapshot)
      if (event.type === 'invoice.payment_failed') {
        const processedAt = (options.now?.() ?? new Date()).toISOString()
        await database.prepare(`
          UPDATE entitlements SET status = 'past_due', payment_status = 'failed', updated_at = ?
          WHERE environment = ? AND stripe_subscription_id = ?
        `).bind(processedAt, options.environment, subscriptionId).run()
      } else if (event.type === 'invoice.paid') {
        const processedAt = (options.now?.() ?? new Date()).toISOString()
        await database.prepare(`
          UPDATE entitlements SET payment_status = 'paid', updated_at = ?
          WHERE environment = ? AND stripe_subscription_id = ?
        `).bind(processedAt, options.environment, subscriptionId).run()
      }
      return
    }
    await markRefund(event)
  }
}

/** Utility for test fixtures and operational webhook diagnostics. */
export async function createStripeSignatureHeader(rawBody: string, secret: string, timestamp: number): Promise<string> {
  const signature = await stripeWebhookMac(secret, timestamp, utf8(rawBody))
  return `t=${timestamp},v1=${bytesToHex(signature)}`
}
