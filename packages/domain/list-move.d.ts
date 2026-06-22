import type { ListLikeEntry } from './identity'

export const MOVE_TICKET_FIELDS: string[]

export interface BuildMovedItemOptions {
    /** Form-collected ticket fields, merged when the target is a board. */
    fields?: Record<string, unknown> | null
    /** Timestamp written to the destination item's updatedAt. Defaults to Date.now(). */
    now?: number
    /** Local writer key hex, stamped as createdBy when promoting into a board. */
    writerKey?: string | null
}

/** True when the move stays inside the same listId bucket (only the type changes). */
export function isSameSurfaceMove(sourceItem: ListLikeEntry | null | undefined, targetListId: unknown): boolean

/**
 * Shape the destination item for a move. Preserves `id` and base fields, bumps
 * `updatedAt`, rewrites `listId`/`listType` (board → legacy wire type), drops any
 * manual `order`, and stamps/keeps board fields per the keep-dormant policy.
 */
export function buildMovedItem<T extends ListLikeEntry>(
    sourceItem: T,
    targetListId: unknown,
    targetListType: unknown,
    opts?: BuildMovedItemOptions,
): T & { id: string; listId: string; listType: string; updatedAt: number }
