// Pure swipe-navigation math for the mobile list pager (and reusable elsewhere).
//
// The app navigates lists by swiping: within a group, then across the group
// boundary (with a toast), or jumping a whole group on a long-press+swipe. This
// module is pure — the caller assembles a NavLibrary from the reduced registry
// (see list-registry.mjs) plus any lists that exist but aren't filed yet, and
// asks for the next/previous destination. No wrap-around by default.

export const UNGROUPED_GROUP_ID = '__ungrouped__'

function numberOr (value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// Assemble the ordered navigation structure.
//   registry: { groups:[{id,name,order}], lists:[{id,name,type,groupId,order}] } from reduceRegistry
//   extraLists: lists that exist (have items) but have no registry entry → Ungrouped
//   defaultListId: the per-device default; ungroupedName: localized label for the implicit group
export function toNavLibrary (registry, { extraLists = [], defaultListId = null, ungroupedName = 'Ungrouped' } = {}) {
    const reg = registry && typeof registry === 'object' ? registry : { groups: [], lists: [] }
    const regGroups = Array.isArray(reg.groups) ? reg.groups : []
    const regLists = Array.isArray(reg.lists) ? reg.lists : []

    const listsById = {}
    for (const l of regLists) {
        if (l && typeof l.id === 'string') listsById[l.id] = { id: l.id, name: l.name || '', type: l.type || '', groupId: l.groupId ?? null, order: numberOr(l.order, 0), view: l.view, baseKey: l.baseKey ?? null }
    }
    for (const l of (Array.isArray(extraLists) ? extraLists : [])) {
        if (l && typeof l.id === 'string' && !listsById[l.id]) {
            listsById[l.id] = { id: l.id, name: l.name || '', type: l.type || '', groupId: null, order: numberOr(l.order, Number.MAX_SAFE_INTEGER), view: undefined, baseKey: l.baseKey ?? null }
        }
    }

    const knownGroupIds = new Set(regGroups.map((g) => g.id))
    const byOrderThenName = (a, b) => (numberOr(a.order, 0) - numberOr(b.order, 0)) || String(a.name).localeCompare(String(b.name))

    const groups = []
    for (const g of [...regGroups].sort(byOrderThenName)) {
        const listIds = Object.values(listsById)
            .filter((l) => l.groupId === g.id)
            .sort(byOrderThenName)
            .map((l) => l.id)
        groups.push({ id: g.id, name: g.name || '', listIds })
    }

    // Lists with no group, or pointing at a missing group → the implicit Ungrouped group, last.
    const ungroupedListIds = Object.values(listsById)
        .filter((l) => l.groupId == null || !knownGroupIds.has(l.groupId))
        .sort(byOrderThenName)
        .map((l) => l.id)
    if (ungroupedListIds.length) {
        groups.push({ id: UNGROUPED_GROUP_ID, name: ungroupedName, listIds: ungroupedListIds })
    }

    return { groups, listsById, defaultListId: defaultListId ?? null }
}

// A linear walk over every list in display order: [{listId, groupId, groupName}].
export function flatten (lib) {
    const out = []
    for (const g of (lib?.groups || [])) {
        for (const listId of (g.listIds || [])) out.push({ listId, groupId: g.id, groupName: g.name })
    }
    return out
}

export function locate (lib, listId) {
    const groups = lib?.groups || []
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]
        const idx = (g.listIds || []).indexOf(listId)
        if (idx !== -1) {
            return {
                groupId: g.id,
                groupName: g.name,
                indexInGroup: idx,
                groupSize: g.listIds.length,
                groupIndex: gi,
                groupCount: groups.length,
            }
        }
    }
    return null
}

// dir: +1 = swipe LEFT (next), -1 = swipe RIGHT (prev).
// jumpGroup: skip to the first list of the adjacent group in `dir`.
export function step (lib, currentListId, dir, opts = {}) {
    const wrap = opts.wrap === true
    const groups = lib?.groups || []
    const none = { listId: null, crossedGroup: false, wrapped: false }

    const here = locate(lib, currentListId)
    if (!here) {
        // Unknown current: fall back to the first list overall.
        const flat = flatten(lib)
        return flat.length ? { listId: flat[0].listId, crossedGroup: true, toGroupName: flat[0].groupName, wrapped: false } : none
    }

    if (opts.jumpGroup) {
        if (!groups.length) return none
        let gi = here.groupIndex + dir
        if (gi < 0 || gi >= groups.length) {
            if (!wrap) return none
            gi = (gi + groups.length) % groups.length
        }
        // Skip empty groups in the jump direction.
        let guard = groups.length
        while (guard-- > 0 && !(groups[gi].listIds || []).length) {
            gi += dir
            if (gi < 0 || gi >= groups.length) {
                if (!wrap) return none
                gi = (gi + groups.length) % groups.length
            }
        }
        const dest = groups[gi].listIds[0]
        if (!dest) return none
        return { listId: dest, crossedGroup: true, toGroupName: groups[gi].name, wrapped: false }
    }

    const flat = flatten(lib)
    const i = flat.findIndex((e) => e.listId === currentListId)
    if (i === -1) return none
    let j = i + dir
    let wrapped = false
    if (j < 0 || j >= flat.length) {
        if (!wrap) return none
        j = (j + flat.length) % flat.length
        wrapped = true
    }
    const dest = flat[j]
    const crossedGroup = dest.groupId !== here.groupId
    return {
        listId: dest.listId,
        crossedGroup,
        toGroupName: crossedGroup ? dest.groupName : undefined,
        wrapped,
    }
}

export function nextList (lib, id, opts) { return step(lib, id, 1, opts) }
export function prevList (lib, id, opts) { return step(lib, id, -1, opts) }

export function crossesGroupBoundary (lib, currentListId, dir, opts = {}) {
    const move = step(lib, currentListId, dir, opts)
    return { crosses: !!move.listId && move.crossedGroup, toGroupName: move.toGroupName }
}

// Launch resolution: user default (if still valid) → first list overall → null.
export function resolveLaunchList (lib, validIds = null) {
    const def = lib?.defaultListId
    const valid = (id) => !!id && (!validIds || validIds.has(id)) && !!lib?.listsById?.[id]
    if (valid(def)) return def
    const flat = flatten(lib)
    for (const e of flat) if (!validIds || validIds.has(e.listId)) return e.listId
    return null
}
