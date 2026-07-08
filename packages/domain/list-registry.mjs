// Pure list-registry logic shared by every Listam client.
//
// "Which lists exist, what type they are, which group they belong to, and in
// what order" is synced across the project by storing each list/group as an
// ordinary item in a reserved registry list (listType === 'registry'). Those
// meta-items ride the existing add/update/delete/sync pipeline (LWW by
// updatedAt, epoch-encrypted, attributed) — so no new backend record type is
// needed. This module interprets the reduced meta-items into an ordered
// {groups, lists} structure, and builds the meta-items the UI sends.
//
// A meta-item's own `id` IS the id of the list or group it describes (a list's
// id matches the listId its real items carry), so the registry entry and the
// list's content are tied together. Registry-specific fields are `reg`-prefixed
// to avoid clashing with the base item shape.

import { isBoardType, BOARD_LIST_TYPE } from './board.mjs'

export const REGISTRY_LIST_ID = '__registry__'
export const REGISTRY_LIST_TYPE = 'registry'

export const REG_KIND_LIST = 'list'
export const REG_KIND_GROUP = 'group'
// A singleton settings meta-item (one per project/base) carrying project-wide
// preferences that must sync — currently the default target list for un-targeted
// adds (voice "aggiungi X" with no spoken list; the app's quick-add). It rides
// the same registry sync/LWW pipeline as lists and groups, so a new backend
// record type is avoided. Fixed id so every peer's write LWW-merges onto one item.
export const REG_KIND_SETTINGS = 'settings'
export const PROJECT_SETTINGS_ID = '__projectsettings__'

export function isRegistryItem (item) {
    return !!item && typeof item === 'object' && item.listType === REGISTRY_LIST_TYPE
}

function numberOr (value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// The per-list view settings carried on a list meta-item (synced across the
// project). Each list remembers how it is displayed. `sanitizeView` keeps only
// known keys with valid values so a malformed/old peer can never poison the view.
const VIEW_BOOL_KEYS = ['isGridView', 'categoriesEnabled', 'categoryHeadersVisible', 'showFab']
const VIEW_ENUM_KEYS = {
    gridIconSize: ['small', 'medium', 'normal', 'large'],
    listTextSize: ['small', 'medium', 'normal', 'large'],
    listAlignment: ['left', 'center'],
    listItemSpacing: ['compact', 'cozy', 'normal', 'relaxed'],
    itemIconVariant: ['illustrated', 'minimal'],
}

export function sanitizeView (view) {
    const out = {}
    if (!view || typeof view !== 'object') return out
    for (const k of VIEW_BOOL_KEYS) if (typeof view[k] === 'boolean') out[k] = view[k]
    for (const k of Object.keys(VIEW_ENUM_KEYS)) {
        if (VIEW_ENUM_KEYS[k].includes(view[k])) out[k] = view[k]
    }
    return out
}

// Build the synced item that declares a LIST in the registry. Caller supplies
// `updatedAt` (now()) — this module stays pure. `view` is optional; when given,
// only sanitized presentation keys are stored under `regView`.
//
// `baseKey` points the list's ITEMS at a base: null/absent = this (personal)
// base; a hex key = a shared single-list base (multi-base sharing). It is written
// only when present, so existing single-base entries are unchanged and old peers
// that ignore `regBaseKey` keep reducing the registry correctly.
export function buildListMetaItem ({ id, name, type, groupId = null, order = 0, view, baseKey = null, updatedAt }) {
    const item = {
        id,
        listId: REGISTRY_LIST_ID,
        listType: REGISTRY_LIST_TYPE,
        text: typeof name === 'string' ? name : '',
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: numberOr(updatedAt, 0),
        regKind: REG_KIND_LIST,
        regName: typeof name === 'string' ? name : '',
        regType: typeof type === 'string' ? type : '',
        regGroupId: groupId == null ? null : String(groupId),
        regOrder: numberOr(order, 0),
    }
    if (view && typeof view === 'object') item.regView = sanitizeView(view)
    if (baseKey != null && String(baseKey)) item.regBaseKey = String(baseKey)
    return item
}

// Build the synced item that declares a GROUP in the registry.
export function buildGroupMetaItem ({ id, name, order = 0, updatedAt }) {
    return {
        id,
        listId: REGISTRY_LIST_ID,
        listType: REGISTRY_LIST_TYPE,
        text: typeof name === 'string' ? name : '',
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: numberOr(updatedAt, 0),
        regKind: REG_KIND_GROUP,
        regName: typeof name === 'string' ? name : '',
        regOrder: numberOr(order, 0),
    }
}

// Build the singleton project-settings meta-item. `defaultListId`/`defaultListType`
// name the list un-targeted adds land in; null/empty clears the preference (back
// to the built-in default). Fixed id (PROJECT_SETTINGS_ID) so writes from any peer
// LWW-merge onto one item.
export function buildProjectSettingsItem ({ defaultListId = null, defaultListType = null, updatedAt } = {}) {
    return {
        id: PROJECT_SETTINGS_ID,
        listId: REGISTRY_LIST_ID,
        listType: REGISTRY_LIST_TYPE,
        text: '',
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: numberOr(updatedAt, 0),
        regKind: REG_KIND_SETTINGS,
        regDefaultListId: typeof defaultListId === 'string' && defaultListId ? defaultListId : null,
        regDefaultListType: typeof defaultListType === 'string' && defaultListType ? defaultListType : null,
    }
}

// Reduce the current set of registry meta-items into ordered {groups, lists}.
// The item pipeline already LWW-merges by id, but we dedupe defensively by
// (kind,id) keeping the newest updatedAt so the function is correct on any
// input. Tombstones (regDeleted === true) are dropped.
export function reduceRegistry (items) {
    const groups = new Map()
    const lists = new Map()
    // Singleton settings, LWW by updatedAt. Null until a settings meta-item is seen.
    let settings = null
    let settingsAt = -1

    for (const item of (Array.isArray(items) ? items : [])) {
        if (!isRegistryItem(item)) continue
        if (item.regDeleted === true) continue
        const id = typeof item.id === 'string' ? item.id : null
        if (!id) continue
        const updatedAt = numberOr(item.updatedAt, 0)

        if (item.regKind === REG_KIND_SETTINGS) {
            if (updatedAt < settingsAt) continue
            settingsAt = updatedAt
            settings = {
                defaultListId: typeof item.regDefaultListId === 'string' && item.regDefaultListId ? item.regDefaultListId : null,
                defaultListType: typeof item.regDefaultListType === 'string' && item.regDefaultListType ? item.regDefaultListType : null,
            }
            continue
        }
        if (item.regKind === REG_KIND_GROUP) {
            const prev = groups.get(id)
            if (prev && numberOr(prev._at, 0) >= updatedAt) continue
            groups.set(id, {
                id,
                name: typeof item.regName === 'string' && item.regName ? item.regName : (item.text || ''),
                order: numberOr(item.regOrder, 0),
                _at: updatedAt,
            })
        } else if (item.regKind === REG_KIND_LIST) {
            const prev = lists.get(id)
            if (prev && numberOr(prev._at, 0) >= updatedAt) continue
            lists.set(id, {
                id,
                name: typeof item.regName === 'string' && item.regName ? item.regName : (item.text || ''),
                // Normalize the legacy board wire value to the canonical one so
                // the nav/UI layer only ever sees BOARD_LIST_TYPE.
                type: isBoardType(item.regType) ? BOARD_LIST_TYPE : (typeof item.regType === 'string' ? item.regType : ''),
                groupId: item.regGroupId == null ? null : String(item.regGroupId),
                order: numberOr(item.regOrder, 0),
                view: (item.regView && typeof item.regView === 'object') ? sanitizeView(item.regView) : undefined,
                // The base this list's items live in: null = the personal base;
                // a hex key = a shared single-list base.
                baseKey: typeof item.regBaseKey === 'string' && item.regBaseKey ? item.regBaseKey : null,
                _at: updatedAt,
            })
        }
    }

    const strip = ({ _at, ...rest }) => rest
    const byOrderThenName = (a, b) => (a.order - b.order) || a.name.localeCompare(b.name)

    return {
        groups: [...groups.values()].map(strip).sort(byOrderThenName),
        lists: [...lists.values()].map(strip).sort(byOrderThenName),
        // null when the project has never set a default; consumers fall back to
        // the built-in default (see resolveDefaultListTarget).
        settings,
    }
}

// Resolve the target for an un-targeted add (voice with no spoken list, quick-add)
// against the synced project settings. Returns { id, type }. The chosen list is
// honored only if it still exists in the registry — if it was deleted, or no
// preference is set, this falls back to `fallback` (the built-in default the
// caller supplies, e.g. identity's DEFAULT_LIST_ID / DEFAULT_LIST_TYPE).
export function resolveDefaultListTarget (items, fallback = {}) {
    const fid = typeof fallback.id === 'string' ? fallback.id : null
    const ftype = typeof fallback.type === 'string' ? fallback.type : null
    const { lists, settings } = reduceRegistry(items)
    const wantId = settings?.defaultListId
    if (wantId) {
        const match = lists.find((l) => l.id === wantId)
        if (match) {
            // Prefer the stored type, else the list's own type, else fallback.
            return { id: match.id, type: settings.defaultListType || match.type || ftype }
        }
        // The preferred list no longer exists — fall through to the built-in default.
    }
    return { id: fid, type: ftype }
}
