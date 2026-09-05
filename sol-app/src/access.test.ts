import assert from 'node:assert/strict'
import test from 'node:test'
import { quoteOneTimeRange, quoteSubscriptionWindow } from './access'

const DAY = 86_400_000

test('one-time ranges bill every started seven-day unit and discount unit seven onward', () => {
  const start = new Date('2026-07-01T15:00:00.000Z')
  assert.deepEqual(quoteOneTimeRange(start, new Date(start.valueOf() + 7 * DAY)), {
    accessModel: 'one_time_range',
    rangeStart: '2026-07-01T15:00:00.000Z',
    rangeEnd: '2026-07-08T15:00:00.000Z',
    sevenDayUnits: 1,
    fullPriceUnits: 1,
    discountedUnits: 0,
    amountCents: 2500,
    currency: 'usd',
    pricingVersion: 'outdock-2026-09',
  })
  assert.equal(quoteOneTimeRange(start, new Date(start.valueOf() + 42 * DAY)).amountCents, 15_000)
  assert.equal(quoteOneTimeRange(start, new Date(start.valueOf() + 42 * DAY + 1)).amountCents, 16_250)
})

test('subscription covers a 30-day lookback and 28 live access days', () => {
  const quote = quoteSubscriptionWindow('2026-07-01T15:00:00.000Z')
  assert.equal(quote.rangeStart, '2026-06-01T15:00:00.000Z')
  assert.equal(quote.rangeEnd, '2026-07-29T15:00:00.000Z')
  assert.equal(quote.amountCents, 8_800)
})
