export const DEFAULT_LIST_ID = 'default'
export const DEFAULT_LIST_TYPE = 'shopping'

export function normalizeListId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_LIST_ID
}

export function normalizeListType(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_LIST_TYPE
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
