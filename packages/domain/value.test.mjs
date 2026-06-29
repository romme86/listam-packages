import test from 'node:test'
import assert from 'node:assert/strict'
import {
    VALUE_MIN,
    VALUE_MAX,
    clampRate,
    hasValueRating,
    validateValueDraft,
    summarizeValue,
    aggregateCompletedValuePerDay,
    valueStatsForPeriod,
} from './value.mjs'
import { toDateKey } from './plan.mjs'

const DAY = 86400000
// A fixed, DST-agnostic local-noon anchor for deterministic bucketing.
const NOW = new Date(2026, 5, 29, 12, 0, 0).getTime() // 2026-06-29 local

function rated (valueRate, delayRate, { done = true, at = NOW } = {}) {
    return { id: `i-${valueRate}-${delayRate}-${at}`, text: 't', listType: 'todo', isDone: done, timeOfCompletion: done ? at : 0, valueRate, delayRate }
}

test('clampRate coerces to an integer in [1,10] or null', () => {
    assert.equal(VALUE_MIN, 1)
    assert.equal(VALUE_MAX, 10)
    assert.equal(clampRate(5), 5)
    assert.equal(clampRate(0), 1)      // below min clamps up
    assert.equal(clampRate(99), 10)    // above max clamps down
    assert.equal(clampRate(3.6), 4)    // rounds
    assert.equal(clampRate('7'), null) // non-number is unrated
    assert.equal(clampRate(undefined), null)
    assert.equal(clampRate(NaN), null)
})

test('hasValueRating requires both rates valid', () => {
    assert.equal(hasValueRating({ valueRate: 5, delayRate: 2 }), true)
    assert.equal(hasValueRating({ valueRate: 5 }), false)
    assert.equal(hasValueRating({ delayRate: 2 }), false)
    assert.equal(hasValueRating({}), false)
    assert.equal(hasValueRating(null), false)
})

test('validateValueDraft reports the missing rates', () => {
    assert.deepEqual(validateValueDraft({ valueRate: 5, delayRate: 2 }), { ok: true, missing: [] })
    assert.deepEqual(validateValueDraft({ valueRate: 5 }), { ok: false, missing: ['delay'] })
    assert.deepEqual(validateValueDraft({}), { ok: false, missing: ['value', 'delay'] })
})

test('summarizeValue sums value and averages delay, skipping unrated', () => {
    const s = summarizeValue([rated(6, 2), rated(4, 8), { valueRate: 9 } /* unrated */])
    assert.equal(s.totalValue, 10)
    assert.equal(s.count, 2)
    assert.equal(s.avgDelay, 5) // (2 + 8) / 2
    assert.deepEqual(summarizeValue([]), { totalValue: 0, avgDelay: 0, count: 0 })
})

test('aggregateCompletedValuePerDay yields a dense oldest-first series', () => {
    const items = [
        rated(6, 2, { at: NOW }),            // today
        rated(4, 4, { at: NOW }),            // today
        rated(5, 8, { at: NOW - 2 * DAY }),  // two days ago
        rated(3, 1, { done: false }),         // not done -> excluded
    ]
    const series = aggregateCompletedValuePerDay(items, { daysBack: 3, nowMs: NOW })
    assert.equal(series.length, 3)
    // oldest first
    assert.equal(series[0].dateKey, toDateKey(NOW - 2 * DAY))
    assert.equal(series[2].dateKey, toDateKey(NOW))
    // two-days-ago bucket
    assert.equal(series[0].totalValue, 5)
    assert.equal(series[0].avgDelay, 8)
    assert.equal(series[0].count, 1)
    // yesterday is zero-filled
    assert.equal(series[1].totalValue, 0)
    assert.equal(series[1].count, 0)
    // today: value summed, delay averaged
    assert.equal(series[2].totalValue, 10)
    assert.equal(series[2].avgDelay, 3) // (2 + 4) / 2
    assert.equal(series[2].count, 2)
})

test('valueStatsForPeriod buckets by day/month/quarter/year', () => {
    const items = [
        rated(6, 2, { at: NOW }),               // this day/month/Q2/year
        rated(4, 6, { at: new Date(2026, 5, 1, 12).getTime() }),  // earlier this month + Q2 + year
        rated(7, 3, { at: new Date(2026, 0, 15, 12).getTime() }), // Jan -> same year, different month/quarter
        rated(9, 9, { at: new Date(2025, 5, 1, 12).getTime() }),  // last year -> excluded from year
    ]
    const day = valueStatsForPeriod(items, 'day', { nowMs: NOW })
    assert.equal(day.totalValue, 6)
    assert.equal(day.count, 1)

    const month = valueStatsForPeriod(items, 'month', { nowMs: NOW })
    assert.equal(month.totalValue, 10) // 6 + 4
    assert.equal(month.count, 2)
    assert.equal(month.avgDelay, 4)    // (2 + 6) / 2

    const quarter = valueStatsForPeriod(items, 'quarter', { nowMs: NOW })
    assert.equal(quarter.periodKey, '2026-Q2')
    assert.equal(quarter.totalValue, 10) // both June items, Jan is Q1
    assert.equal(quarter.count, 2)

    const year = valueStatsForPeriod(items, 'year', { nowMs: NOW })
    assert.equal(year.totalValue, 17) // 6 + 4 + 7, last-year excluded
    assert.equal(year.count, 3)
})
