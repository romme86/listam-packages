export type RegistryLike = { lists?: Array<{ id?: string; baseKey?: string | null }> } | null | undefined

/** listId -> the base its items must come from (null = the personal base). */
export type AuthoritativeBaseIndex = Map<string, string | null> | Record<string, string | null>

/** Map each listId to the base its items must come from (null = personal base). */
export declare function buildAuthoritativeBaseIndex(registry: RegistryLike): Map<string, string | null>

/**
 * True when an item may be projected: it came from the base the registry says
 * owns that list, or the registry has nothing to say about it (fails open).
 *
 * Accepts a Map or a plain object, so a reducer can hold the index in Immer
 * state without rebuilding a Map on every item event.
 */
export declare function isFromAuthoritativeBase(
    item: unknown,
    index: AuthoritativeBaseIndex | null | undefined,
): boolean

/**
 * The list id and base key a registry meta-item declares, or null if it is not
 * one. Lets a reducer maintain the index incrementally as registry items arrive.
 * Returns null for a SHARED base's own self-describing meta-item, which
 * describes that base rather than the personal registry's routing decision.
 */
export declare function listBaseFromRegistryItem(
    item: unknown,
): { listId: string; baseKey: string | null } | null

/** As isFromAuthoritativeBase, but rebuilds the index from a reduced registry each call. */
export declare function acceptsItemFromBase(item: unknown, registry: RegistryLike): boolean
