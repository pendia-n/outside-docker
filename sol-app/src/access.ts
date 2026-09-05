import { DomainError } from './chain-do'

export const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60
export const ONE_TIME_UNIT_CENTS = 2_500
export const ONE_TIME_DISCOUNTED_UNIT_CENTS = 1_250
export const ONE_TIME_FULL_PRICE_UNITS = 6
export const SUBSCRIPTION_CENTS = 8_800
export const SUBSCRIPTION_ACCESS_DAYS = 28
export const SUBSCRIPTION_LOOKBACK_DAYS = 30

export interface AccessWindowQuote {
  accessModel: 'one_time_range' | 'subscription_28d'
  rangeStart: string
  rangeEnd: string
  sevenDayUnits: number | null
  fullPriceUnits: number | null
  discountedUnits: number | null
  amountCents: number
  currency: 'usd'
  pricingVersion: 'outdock-2026-09'
}

function instant(value: string | Date, field: string): Date {
  const parsed = value instanceof Date ? new Date(value.valueOf()) : new Date(value)
  if (!Number.isFinite(parsed.valueOf())) throw new DomainError(400, 'invalid_access_range', `${field} must be an ISO-8601 timestamp`)
  return parsed
}

/** Quote an end-exclusive historical range. Any partial seven-day unit rounds up. */
export function quoteOneTimeRange(startValue: string | Date, endValue: string | Date): AccessWindowQuote {
  const start = instant(startValue, 'range_start')
  const end = instant(endValue, 'range_end')
  const seconds = (end.valueOf() - start.valueOf()) / 1000
  if (seconds <= 0) throw new DomainError(400, 'invalid_access_range', 'range_end must be after range_start')
  const units = Math.ceil(seconds / SEVEN_DAYS_SECONDS)
  if (units > 520) throw new DomainError(400, 'access_range_too_large', 'One checkout may cover at most ten years')
  const fullPriceUnits = Math.min(units, ONE_TIME_FULL_PRICE_UNITS)
  const discountedUnits = Math.max(0, units - ONE_TIME_FULL_PRICE_UNITS)
  return {
    accessModel: 'one_time_range',
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
    sevenDayUnits: units,
    fullPriceUnits,
    discountedUnits,
    amountCents: fullPriceUnits * ONE_TIME_UNIT_CENTS + discountedUnits * ONE_TIME_DISCOUNTED_UNIT_CENTS,
    currency: 'usd',
    pricingVersion: 'outdock-2026-09',
  }
}

/** Subscription data begins 30 days before payment and remains live for 28 days. */
export function quoteSubscriptionWindow(paidAtValue: string | Date): AccessWindowQuote {
  const paidAt = instant(paidAtValue, 'paid_at')
  const start = new Date(paidAt.valueOf() - SUBSCRIPTION_LOOKBACK_DAYS * 86_400_000)
  const end = new Date(paidAt.valueOf() + SUBSCRIPTION_ACCESS_DAYS * 86_400_000)
  return {
    accessModel: 'subscription_28d',
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
    sevenDayUnits: null,
    fullPriceUnits: null,
    discountedUnits: null,
    amountCents: SUBSCRIPTION_CENTS,
    currency: 'usd',
    pricingVersion: 'outdock-2026-09',
  }
}
