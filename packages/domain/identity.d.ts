export const DEFAULT_LIST_ID: 'default'
export const DEFAULT_LIST_TYPE: 'shopping'

export type ListLikeEntry = {
    id?: string
    itemId?: string
    listId?: string
    listType?: string
    text?: string
    updatedAt?: number
    [key: string]: unknown
}

export function normalizeListId(value: unknown): string
export function normalizeListType(value: unknown): string
export function legacyItemId(text: string, listId?: string): string
export function normalizeItemId(item: ListLikeEntry | null | undefined): string | null
export function identityKey(item: ListLikeEntry | null | undefined): string
export function updatedAtOf(item: ListLikeEntry | null | undefined): number
export function isStaleUpdate(existing: ListLikeEntry | null | undefined, incoming: ListLikeEntry | null | undefined): boolean
export function normalizeListEntry<T extends ListLikeEntry>(entry: T): T & { id: string; listId: string; listType: string }
export function normalizeListEntries<T extends ListLikeEntry>(entries: T[]): Array<T & { id: string; listId: string; listType: string }>
export function sameListEntry(left: ListLikeEntry, right: ListLikeEntry): boolean
export function upsertListEntry<T extends ListLikeEntry>(entries: T[], entry: T, placement?: 'front' | 'preserve'): Array<T & { id: string; listId: string; listType: string }>
export function updateListEntry<T extends ListLikeEntry>(entries: T[], entry: T): Array<T & { id: string; listId: string; listType: string }>
export function deleteListEntry<T extends ListLikeEntry>(entries: T[], entry: T): T[]
