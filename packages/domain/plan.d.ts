export const PLAN_LIST_ID: '__plan__'
export const PLAN_LIST_TYPE: 'plan'
export const PLAN_KIND_ITEM: 'item'
export const PLAN_KIND_LIST: 'list'

export type PlanKind = 'item' | 'list'

export interface PlanRecord {
    ref: string
    kind: PlanKind
    refListId: string
    refItemId: string
    refType: string
    plannedFor: string
    planOrder: number
    updatedAt: number
}

export interface PlanReorderUpdate {
    ref: string
    planOrder: number
}

export function isPlanItem (item: unknown): boolean

export function planItemKey (listId: string, itemId: string): string
export function planListKey (listId: string, listType?: string): string

export function toDateKey (ms: number): string
export function shiftDateKey (dateKey: string, days: number): string
export function isPastDateKey (dateKey: string, todayKey: string): boolean

export function buildPlanItem (args: {
    id: string
    kind: PlanKind
    refListId: string
    refItemId?: string
    refType?: string
    plannedFor: string
    planOrder?: number
    updatedAt: number
}): Record<string, unknown>

export function buildItemPlanEntry (args: {
    listId: string
    itemId: string
    plannedFor: string
    planOrder?: number
    updatedAt: number
}): Record<string, unknown>

export function buildListPlanEntry (args: {
    listId: string
    listType?: string
    plannedFor: string
    planOrder?: number
    updatedAt: number
}): Record<string, unknown>

export function reducePlan (items: unknown[] | null | undefined): Map<string, PlanRecord>
export function groupPlanByDate (reduced: Map<string, PlanRecord> | PlanRecord[]): Map<string, PlanRecord[]>
export function overduePlanRecords (reduced: Map<string, PlanRecord> | PlanRecord[], todayKey: string): PlanRecord[]
export function computePlanReorder (
    orderedRecords: PlanRecord[],
    fromIndex: number,
    toIndex: number,
): { updates: PlanReorderUpdate[]; renormalized: boolean }
