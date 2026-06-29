// The "value return" property — pure, DOM-free helpers shared by every Listam
// client. A rated item carries two integers: `valueRate` (1-10: how much value
// the task gives back) and `delayRate` (1-10: how soon — 1 = soon, 10 = far).
//
// The per-surface ENABLE flag lives in the synced value-return channel
// (labels.mjs `buildValueReturnItem` / `reduceValueReturn`); this module is only
// the rate math + completed-value aggregation that powers the desktop Overview
// "Value" tab, the period stats, and the per-day/week rollups. Completion time is
// the item's existing `timeOfCompletion` (set on done, 0 when reopened) — no new
// field is needed.

import { toDateKey, shiftDateKey } from './plan.mjs'

export const VALUE_MIN = 1
export const VALUE_MAX = 10

function numberOr (value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// Coerce a raw rate to an integer in [VALUE_MIN, VALUE_MAX], or null if it is
// absent / not a finite number (so callers can distinguish "unrated" from a 0).
export function clampRate (value) {
    const n = Math.round(numberOr(value, NaN))
    if (!Number.isFinite(n)) return null
    return Math.min(VALUE_MAX, Math.max(VALUE_MIN, n))
}

// True when an item carries BOTH a valid value and delay rate.
export function hasValueRating (item) {
    return !!item && typeof item === 'object' &&
        clampRate(item.valueRate) != null && clampRate(item.delayRate) != null
}

// Which mandatory rates are missing from a draft. Mirrors board's
// validateTicketDraft shape ({ ok, missing }) so the create-dialog gating reads
// identically (missing entries: 'value' and/or 'delay').
export function validateValueDraft (draft) {
    const missing = []
    const d = draft || {}
    if (clampRate(d.valueRate) == null) missing.push('value')
    if (clampRate(d.delayRate) == null) missing.push('delay')
    return { ok: missing.length === 0, missing }
}

// An item counts toward completed-value tracking once it is done AND carries a
// real completion timestamp (a board ticket reopened, or a todo unchecked, has
// timeOfCompletion reset to 0).
function isCompleted (item) {
    return !!item && item.isDone === true && numberOr(item.timeOfCompletion, 0) > 0
}

// Sum value + average delay over an arbitrary list of items (unrated ones are
// skipped). Used for the Overview per-day / per-week rollups: value summed,
// delay averaged ("avg delay per value").
export function summarizeValue (items) {
    let totalValue = 0
    let sumDelay = 0
    let count = 0
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!hasValueRating(item)) continue
        totalValue += clampRate(item.valueRate)
        sumDelay += clampRate(item.delayRate)
        count += 1
    }
    return { totalValue, avgDelay: count ? sumDelay / count : 0, count }
}

// Per-day series of COMPLETED value over the last `daysBack` calendar days
// (inclusive of today), oldest-first. Each point feeds the two-line chart:
//   { dateKey, totalValue, avgDelay, count }
// The series is dense (days with no completions are zero-filled) so the chart has
// a continuous axis. `nowMs` is injectable for deterministic tests.
export function aggregateCompletedValuePerDay (items, { daysBack = 30, nowMs = Date.now() } = {}) {
    const byDay = new Map() // dateKey -> { totalValue, sumDelay, count }
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!isCompleted(item) || !hasValueRating(item)) continue
        const key = toDateKey(item.timeOfCompletion)
        if (!key) continue
        const g = byDay.get(key) || { totalValue: 0, sumDelay: 0, count: 0 }
        g.totalValue += clampRate(item.valueRate)
        g.sumDelay += clampRate(item.delayRate)
        g.count += 1
        byDay.set(key, g)
    }
    const today = toDateKey(nowMs)
    const span = Math.max(1, Math.floor(daysBack))
    const out = []
    for (let i = span - 1; i >= 0; i--) {
        const key = shiftDateKey(today, -i)
        const g = byDay.get(key)
        out.push({
            dateKey: key,
            totalValue: g ? g.totalValue : 0,
            avgDelay: g && g.count ? g.sumDelay / g.count : 0,
            count: g ? g.count : 0,
        })
    }
    return out
}

// Bucket a 'YYYY-MM-DD' completion key into the key for a period granularity.
function periodKeyOf (dateKey, period) {
    if (!dateKey) return ''
    if (period === 'year') return dateKey.slice(0, 4)
    if (period === 'month') return dateKey.slice(0, 7)
    if (period === 'quarter') {
        const month = Number(dateKey.slice(5, 7))
        return `${dateKey.slice(0, 4)}-Q${Math.ceil(month / 3)}`
    }
    return dateKey // 'day'
}

// Sum value + average delay over completed items that fall in the SAME period as
// `nowMs` for the requested granularity ('day' | 'month' | 'quarter' | 'year').
// Returns { period, periodKey, totalValue, avgDelay, count }.
export function valueStatsForPeriod (items, period, { nowMs = Date.now() } = {}) {
    const target = periodKeyOf(toDateKey(nowMs), period)
    let totalValue = 0
    let sumDelay = 0
    let count = 0
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!isCompleted(item) || !hasValueRating(item)) continue
        if (periodKeyOf(toDateKey(item.timeOfCompletion), period) !== target) continue
        totalValue += clampRate(item.valueRate)
        sumDelay += clampRate(item.delayRate)
        count += 1
    }
    return { period, periodKey: target, totalValue, avgDelay: count ? sumDelay / count : 0, count }
}
