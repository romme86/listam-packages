import {
    DEFAULT_LIST_ID,
    DEFAULT_LIST_TYPE,
    normalizeListId,
    normalizeListType,
    legacyItemId,
    normalizeItemId,
    isStaleUpdate,
} from './identity.mjs'

export { DEFAULT_LIST_ID, DEFAULT_LIST_TYPE, legacyItemId }

export const LIST_OPERATION_VERSION = 1

const LIST_OPERATION_TYPES = new Set(['add', 'update', 'delete', 'list'])

export function normalizeListItem(item, options = {}) {
    if (!item || typeof item !== 'object') return null
    if (typeof item.text !== 'string') return null
    if (typeof item.isDone !== 'boolean') return null
    if (typeof item.timeOfCompletion !== 'number') return null

    const listId = normalizeListId(item.listId ?? options.listId)
    const listType = normalizeListType(item.listType ?? options.listType)
    const id = normalizeItemId({ ...item, listId })
    if (!id) return null

    const normalized = {
        ...item,
        id,
        listId,
        listType,
        text: item.text,
        isDone: item.isDone,
        timeOfCompletion: item.timeOfCompletion,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    }

    if (typeof item.timestamp !== 'number') delete normalized.timestamp
    return normalized
}

export function normalizeDeleteItem(item, options = {}) {
    if (!item || typeof item !== 'object') return null
    const listId = normalizeListId(item.listId ?? options.listId)
    const listType = normalizeListType(item.listType ?? options.listType)
    const id = normalizeItemId({ ...item, listId })
    if (!id) return null

    return {
        ...item,
        id,
        listId,
        listType,
        text: typeof item.text === 'string' ? item.text : '',
        isDone: typeof item.isDone === 'boolean' ? item.isDone : false,
        timeOfCompletion: typeof item.timeOfCompletion === 'number' ? item.timeOfCompletion : 0,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    }
}

export function normalizeListItems(items, options = {}) {
    if (!Array.isArray(items)) return []
    return items
        .map((item) => normalizeListItem(item, options))
        .filter(Boolean)
}

export function createListOperation(type, value, options = {}) {
    if (!LIST_OPERATION_TYPES.has(type)) return null

    if (type === 'list') {
        const firstItem = Array.isArray(value)
            ? value.find((entry) => entry && typeof entry === 'object')
            : null
        const listId = normalizeListId(options.listId ?? firstItem?.listId)
        const listType = normalizeListType(options.listType ?? firstItem?.listType)
        return {
            version: LIST_OPERATION_VERSION,
            type,
            listId,
            listType,
            value: normalizeListItems(value, { listId, listType }),
        }
    }

    const listId = normalizeListId(options.listId ?? value?.listId)
    const listType = normalizeListType(options.listType ?? value?.listType)
    const item = type === 'delete'
        ? normalizeDeleteItem(value, { listId, listType })
        : normalizeListItem(value, { listId, listType })
    if (!item) return null

    return {
        version: LIST_OPERATION_VERSION,
        type,
        listId: item.listId,
        listType: item.listType,
        value: item,
    }
}

export function normalizeListOperation(operation) {
    if (!operation || typeof operation !== 'object') return null
    if (!LIST_OPERATION_TYPES.has(operation.type)) return null
    if (operation.version != null && Number(operation.version) > LIST_OPERATION_VERSION) return null

    if (operation.type === 'list') {
        return createListOperation('list', operation.value, {
            listId: operation.listId,
            listType: operation.listType,
        })
    }

    return createListOperation(operation.type, operation.value, {
        listId: operation.listId,
        listType: operation.listType,
    })
}

export function createListViewEntry(operation) {
    const normalized = normalizeListOperation(operation)
    if (!normalized) return null

    if (normalized.type === 'list') {
        return {
            op: 'list',
            version: normalized.version,
            listId: normalized.listId,
            listType: normalized.listType,
            items: normalized.value,
        }
    }

    if (normalized.type === 'delete') {
        return {
            op: 'delete',
            version: normalized.version,
            id: normalized.value.id,
            listId: normalized.value.listId,
            listType: normalized.value.listType,
            text: normalized.value.text,
            item: normalized.value,
        }
    }

    return {
        op: normalized.type,
        version: normalized.version,
        listId: normalized.value.listId,
        listType: normalized.value.listType,
        ...normalized.value,
    }
}

export function normalizeViewEntry(entry) {
    if (!entry || typeof entry !== 'object') return null
    if (entry.op === 'membership') return null

    if (entry.op === 'list' && Array.isArray(entry.items)) {
        return createListOperation('list', entry.items, {
            listId: entry.listId,
            listType: entry.listType,
        })
    }

    if (entry.op === 'add' || entry.op === 'update' || entry.op === 'delete') {
        return createListOperation(entry.op, entry.value ?? entry.item ?? entry, {
            listId: entry.listId,
            listType: entry.listType,
        })
    }

    if (entry.type && LIST_OPERATION_TYPES.has(entry.type)) {
        return normalizeListOperation(entry)
    }

    if (typeof entry.text === 'string') {
        return createListOperation('add', entry, {
            listId: entry.listId,
            listType: entry.listType,
        })
    }

    return null
}

export function reduceListViewEntries(entries, options = {}) {
    return reduceListOperations(entries.map(normalizeViewEntry).filter(Boolean), options)
}

export function reduceListOperations(operations, options = {}) {
    const selectedListId = normalizeListId(options.selectedListId)
    const byList = new Map()

    for (const operation of operations) {
        applyNormalizedOperation(byList, normalizeListOperation(operation))
    }

    return {
        byList,
        items: getListItems(byList, selectedListId),
    }
}

export function applyOperationToList(currentItems, operation, options = {}) {
    const selectedListId = normalizeListId(options.selectedListId)
    const initial = createListOperation('list', Array.isArray(currentItems) ? currentItems : [], {
        listId: selectedListId,
        listType: options.listType,
    })
    const byList = new Map()
    applyNormalizedOperation(byList, initial)
    applyNormalizedOperation(byList, normalizeListOperation(operation))
    return getListItems(byList, selectedListId)
}

// Incremental form of reduceListViewEntries: holds the reduction state so a
// caller replaying a growing operation log (e.g. a materialized-view
// checkpoint) can feed only the entries appended since the last pass instead
// of re-reducing from index 0. Feeding the same entries in the same order
// yields the same items as one reduceListViewEntries call over the full log.
export function createListReduction(options = {}) {
    const selectedListId = normalizeListId(options.selectedListId)
    const byList = new Map()

    return {
        applyEntry(entry) {
            const operation = normalizeViewEntry(entry)
            if (!operation) return false
            applyNormalizedOperation(byList, normalizeListOperation(operation))
            return true
        },
        applyOperation(operation) {
            const normalized = normalizeListOperation(operation)
            if (!normalized) return false
            applyNormalizedOperation(byList, normalized)
            return true
        },
        items(listId = selectedListId) {
            return getListItems(byList, listId)
        },
    }
}

export function sameListItem(left, right) {
    if (!left || !right) return false
    if (normalizeListId(left.listId) !== normalizeListId(right.listId)) return false
    return normalizeItemId(left) === normalizeItemId(right)
}

function applyNormalizedOperation(byList, operation) {
    if (!operation) return

    if (operation.type === 'list') {
        const list = getOrCreateList(byList, operation.listId, operation.listType)
        list.items.clear()
        list.order = []
        for (const item of operation.value) {
            upsertItem(list, item, { placement: 'end' })
        }
        return
    }

    const list = getOrCreateList(byList, operation.value.listId, operation.value.listType)
    if (operation.type === 'delete') {
        removeItem(list, operation.value)
        return
    }

    upsertItem(list, operation.value, {
        placement: operation.type === 'add' ? 'front' : 'preserve',
    })
}

function getOrCreateList(byList, listId, listType) {
    const id = normalizeListId(listId)
    if (!byList.has(id)) {
        byList.set(id, {
            listId: id,
            listType: normalizeListType(listType),
            items: new Map(),
            order: [],
        })
    }
    return byList.get(id)
}

function upsertItem(list, item, { placement }) {
    const id = normalizeItemId(item)
    if (!id) return
    const existing = list.items.get(id)
    if (existing && placement === 'preserve' && isStaleUpdate(existing, item)) return
    list.items.set(id, item)
    if (existing) {
        if (placement === 'front') {
            list.order = [id, ...list.order.filter((entry) => entry !== id)]
        }
        return
    }
    if (placement === 'end') list.order.push(id)
    else list.order.unshift(id)
}

function removeItem(list, item) {
    const id = normalizeItemId(item)
    if (!id) return
    list.items.delete(id)
    list.order = list.order.filter((entry) => entry !== id)
}

function getListItems(byList, listId) {
    const list = byList.get(normalizeListId(listId))
    if (!list) return []
    return list.order
        .map((id) => list.items.get(id))
        .filter(Boolean)
}
