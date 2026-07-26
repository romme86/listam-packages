// Which base is a given list's items allowed to come from?
//
// Sharing a list PROMOTES it: its items are re-seeded into a new single-list
// base with the SAME ids they had in the personal base, and the personal copies
// are then tombstoned. The two bases replicate independently, so those two
// streams race — and the shared copy usually arrives first, because the seed
// happens before the tombstone.
//
// The clients key items by (listId, itemId) via identityKey, which does NOT
// include the base. A late personal tombstone therefore matches the shared copy
// and deletes it: the freshly shared list goes empty, and stays empty until a
// resync. listam-headless already keys by (baseKey, id) and its code says why —
// "keying by id alone would let that tombstone delete drop the shared copy too" —
// but desktop and mobile do not.
//
// This is the defensive half of that fix, kept separate from the full identity
// rework so it can ship without waiting on deterministic apply: the personal
// registry already records where each list's items live (`baseKey`: null for the
// personal base, hex for a shared one), so an event from a base a list was
// promoted AWAY from can simply be ignored.
//
// Fails OPEN by design. An unknown list — registry not replicated yet, a bucket
// with no meta-item, a reserved channel — is always accepted. Dropping items
// because the registry has not arrived would turn a slow sync into data loss,
// which is far worse than the race this guards.
import { normalizeListId } from './identity.mjs'

function normalizeBaseKey (value) {
    if (typeof value !== 'string') return null
    const trimmed = value.trim().toLowerCase()
    return trimmed === '' ? null : trimmed
}

/**
 * Map each listId -> the base its items must come from (null = the personal base).
 * @param {{lists?: Array<{id?: string, baseKey?: string|null}>}} registry a reduced registry
 * @returns {Map<string, string|null>}
 */
export function buildAuthoritativeBaseIndex (registry) {
    const index = new Map()
    const lists = registry && Array.isArray(registry.lists) ? registry.lists : []
    for (const list of lists) {
        if (!list || typeof list.id !== 'string' || list.id === '') continue
        index.set(normalizeListId(list.id), normalizeBaseKey(list.baseKey))
    }
    return index
}

/**
 * True when this item may be projected — i.e. it came from the base the registry
 * says owns that list, or the registry has nothing to say about it.
 *
 * @param {any} item an item from a backend event; `baseKey` is present (hex)
 *   only for items pushed from a SHARED base.
 * @param {Map<string, string|null>} index from buildAuthoritativeBaseIndex
 */
export function isFromAuthoritativeBase (item, index) {
    if (!item || typeof item !== 'object') return true
    if (!index) return true

    const listId = normalizeListId(item.listId)

    // A Map, or a plain object — reducers keep this in Immer state, where a Map
    // is awkward, and rebuilding one per item event would put an allocation on
    // the hottest path in the client.
    let expected
    if (index instanceof Map) {
        if (index.size === 0 || !index.has(listId)) return true // unknown list: fail open
        expected = index.get(listId)
    } else if (typeof index === 'object') {
        if (!Object.prototype.hasOwnProperty.call(index, listId)) return true
        expected = index[listId]
    } else {
        return true
    }

    return normalizeBaseKey(item.baseKey) === normalizeBaseKey(expected)
}

/**
 * The list id and base key a registry meta-item declares, or null if it is not
 * one. Lets a reducer maintain the index incrementally as registry items arrive,
 * instead of re-reducing the whole registry per event.
 */
export function listBaseFromRegistryItem (item) {
    if (!item || typeof item !== 'object') return null
    if (item.regKind !== 'list') return null
    if (typeof item.id !== 'string' || item.id === '') return null
    // A SHARED base seeds its own self-describing meta-item, tagged with the
    // base it came from. That one describes the shared base, not the personal
    // registry's routing decision, so it must not overwrite the index.
    if (normalizeBaseKey(item.baseKey) !== null) return null
    return { listId: normalizeListId(item.id), baseKey: normalizeBaseKey(item.regBaseKey) }
}

/**
 * Convenience for a projection site that holds the reduced registry rather than
 * a prebuilt index. Prefer building the index once per batch when projecting
 * many items — this rebuilds it on every call.
 */
export function acceptsItemFromBase (item, registry) {
    return isFromAuthoritativeBase(item, buildAuthoritativeBaseIndex(registry))
}
