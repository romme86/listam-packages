export const DEFAULT_LIST_ID = 'default'
export const DEFAULT_LIST_TYPE = 'shopping'

// A plain text list: no grocery intelligence (category inference, item icons,
// text normalization), no grid view, no categories. Net-new type — written and
// read as 'todo', so no dual-read shim is needed (cf. the board rename). Old
// peers that predate it sync the items unchanged and merely fall back to the
// default grocery rendering; nothing forks.
export const TODO_LIST_TYPE = 'todo'

// A free-form notes list, written by the voice notetaker ("note … end note").
// Net-new type like 'todo' — written and read as 'notes', so no dual-read shim
// is needed; older peers sync the items untouched and fall back to default
// rendering until desktop/mobile add a dedicated Notes surface.
export const NOTES_LIST_TYPE = 'notes'

export function normalizeListId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_LIST_ID
}

// normalizeListType intentionally accepts ANY non-empty string so a list type
// added by a newer peer round-trips through older peers untouched (forward
// compat). It only fills in the default for missing/blank values.
export function normalizeListType(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_LIST_TYPE
}

// True only for the plain text-list type. Mirrors isBoardType (board.mjs) so
// every client gates grocery-only features (categories, grid, item icons) the
// same way. Unlike boards there is no legacy value to also accept.
export function isTodoType(value) {
    return value === TODO_LIST_TYPE
}

// True only for the voice-notes type. Mirrors isTodoType/isBoardType so clients
// can gate a dedicated Notes surface the same way. No legacy value to accept.
export function isNotesType(value) {
    return value === NOTES_LIST_TYPE
}

export function legacyItemId(text, listId = DEFAULT_LIST_ID) {
    return `legacy-${fnv1aHex(`${normalizeListId(listId)}\0${text}`)}`
}

export function normalizeItemId(item) {
    if (!item || typeof item !== 'object') return null
    const id = typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : typeof item.itemId === 'string' && item.itemId.trim()
            ? item.itemId.trim()
            : ''
    if (id) return id
    if (typeof item.text !== 'string') return null
    return legacyItemId(item.text, item.listId)
}

export function identityKey(item) {
    const listId = normalizeListId(item?.listId)
    return `${listId}\0${normalizeItemId({ ...item, listId }) ?? ''}`
}

// `baseKey` as it appears on an item reaching a CLIENT: transport metadata the
// backend stamps on the way out (hex for a shared base, absent for the personal
// one). Never item data — see the strip at the backend's write boundary.
function normalizeItemBaseKey(value) {
    if (typeof value !== 'string') return ''
    return value.trim().toLowerCase()
}

// Item identity for a CLIENT: (baseKey, listId, itemId).
//
// Sharing a list promotes it — the items are re-seeded into a new single-list
// base with the SAME ids, then the personal copies are tombstoned. The two bases
// replicate independently, so a late personal tombstone matches the shared copy
// under `identityKey` (which has no base) and deletes the list that was just
// shared. `isFromAuthoritativeBase` filters that, but it FAILS OPEN by design:
// an unknown list — registry not replicated yet — is accepted, which is exactly
// the window the race lives in.
//
// Scoping the key by base removes the collision instead of filtering it: the
// tombstone and the shared copy simply are not the same row. The guard still
// decides which base a list should be SHOWN from; this decides what can clobber
// what. They are complementary, and this one holds when the guard fails open.
//
// Deliberately NOT `identityKey` itself. That one is shared with the backend,
// where it drives `applyOperationToList` inside apply — changing it there would
// change what apply produces, which is a consensus change. Inside a base every
// item is from that base, so there is nothing for a base scope to disambiguate.
export function baseScopedKey(item) {
    return `${normalizeItemBaseKey(item?.baseKey)}\0${identityKey(item)}`
}

export function sameBaseScopedEntry(left, right) {
    return baseScopedKey(left) === baseScopedKey(right)
}

export function updatedAtOf(item) {
    return typeof item?.updatedAt === 'number' ? item.updatedAt : 0
}

export function isStaleUpdate(existing, incoming) {
    return updatedAtOf(incoming) < updatedAtOf(existing)
}

export function normalizeListEntry(entry) {
    const listId = normalizeListId(entry?.listId)
    const withList = { ...entry, listId }
    return {
        ...withList,
        id: normalizeItemId(withList) || legacyItemId(String(entry?.text ?? ''), listId),
        listType: normalizeListType(entry?.listType),
    }
}

export function normalizeListEntries(entries) {
    if (!Array.isArray(entries)) return []
    return entries.map(normalizeListEntry)
}

export function sameListEntry(left, right) {
    return identityKey(left) === identityKey(right)
}

export function upsertListEntry(entries, entry, placement = 'front') {
    const normalized = normalizeListEntry(entry)
    const existingIndex = entries.findIndex((candidate) => sameListEntry(candidate, normalized))
    if (existingIndex === -1) {
        return placement === 'front'
            ? [normalized, ...entries]
            : [...entries, normalized]
    }

    if (placement !== 'front' && isStaleUpdate(entries[existingIndex], normalized)) {
        return entries
    }

    const next = entries.map((candidate, index) => (
        index === existingIndex ? { ...candidate, ...normalized } : candidate
    ))
    if (placement !== 'front') return next

    const [moved] = next.splice(existingIndex, 1)
    return [moved, ...next]
}

export function updateListEntry(entries, entry) {
    return upsertListEntry(entries, entry, 'preserve')
}

export function deleteListEntry(entries, entry) {
    const normalized = normalizeListEntry(entry)
    return entries.filter((candidate) => !sameListEntry(candidate, normalized))
}

function fnv1aHex(value) {
    let hash = 0x811c9dc5
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}
