import type { ListLikeEntry } from './identity'

export { DEFAULT_LIST_ID, DEFAULT_LIST_TYPE, legacyItemId } from './identity'

export const LIST_OPERATION_VERSION: 1
export type ListOperationType = 'add' | 'update' | 'delete' | 'list'
export type NormalizedListItem = ListLikeEntry & {
    id: string
    listId: string
    listType: string
    text: string
    isDone: boolean
    timeOfCompletion: number
    updatedAt: number
}
export type ListOperation = {
    version: number
    type: ListOperationType
    listId: string
    listType: string
    value: NormalizedListItem | NormalizedListItem[]
}
export type ReducedList = {
    byList: Map<string, { listId: string; listType: string; items: Map<string, NormalizedListItem>; order: string[] }>
    items: NormalizedListItem[]
}

export function normalizeListItem(item: unknown, options?: { listId?: string; listType?: string }): NormalizedListItem | null
export function normalizeDeleteItem(item: unknown, options?: { listId?: string; listType?: string }): NormalizedListItem | null
export function normalizeListItems(items: unknown, options?: { listId?: string; listType?: string }): NormalizedListItem[]
export function createListOperation(type: ListOperationType, value: unknown, options?: { listId?: string; listType?: string }): ListOperation | null
export function normalizeListOperation(operation: unknown): ListOperation | null
export function createListViewEntry(operation: unknown): Record<string, unknown> | null
export function normalizeViewEntry(entry: unknown): ListOperation | null
export function reduceListViewEntries(entries: unknown[], options?: { selectedListId?: string }): ReducedList
export function reduceListOperations(operations: unknown[], options?: { selectedListId?: string }): ReducedList
export function applyOperationToList(currentItems: unknown[], operation: unknown, options?: { selectedListId?: string; listType?: string }): NormalizedListItem[]
export function sameListItem(left: ListLikeEntry | null | undefined, right: ListLikeEntry | null | undefined): boolean
export type ListReduction = {
    applyEntry(entry: unknown): boolean
    applyOperation(operation: unknown): boolean
    items(listId?: string): NormalizedListItem[]
}
export function createListReduction(options?: { selectedListId?: string }): ListReduction
