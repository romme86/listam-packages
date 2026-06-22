export const ORDER_STEP: number

export type Orderable = { order?: number | null }

export function orderOf(item: Orderable | null | undefined): number | null
export function hasExplicitOrder(items: ReadonlyArray<Orderable> | null | undefined): boolean
export function sortByOrder<T extends Orderable>(items: T[]): T[]
export function orderBetween(before: number | null, after: number | null): number
export function renormalizeOrders<T extends Orderable>(orderedItems: T[]): T[]
export function computeReorder<T extends Orderable>(
    orderedItems: T[],
    fromIndex: number,
    toIndex: number,
): { updates: T[]; renormalized: boolean }
