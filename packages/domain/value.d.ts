export const VALUE_MIN: 1
export const VALUE_MAX: 10

export type ValuePeriod = 'day' | 'month' | 'quarter' | 'year'

export interface ValueSummary {
    totalValue: number
    avgDelay: number
    count: number
}

export interface ValueDayPoint {
    dateKey: string
    totalValue: number
    avgDelay: number
    count: number
}

export interface ValuePeriodStats extends ValueSummary {
    period: ValuePeriod
    periodKey: string
}

export function clampRate (value: unknown): number | null
export function hasValueRating (item: unknown): boolean
export function validateValueDraft (draft: { valueRate?: unknown; delayRate?: unknown } | null | undefined): { ok: boolean; missing: Array<'value' | 'delay'> }
export function summarizeValue (items: unknown[] | null | undefined): ValueSummary
export function aggregateCompletedValuePerDay (items: unknown[] | null | undefined, opts?: { daysBack?: number; nowMs?: number }): ValueDayPoint[]
export function valueStatsForPeriod (items: unknown[] | null | undefined, period: ValuePeriod, opts?: { nowMs?: number }): ValuePeriodStats
