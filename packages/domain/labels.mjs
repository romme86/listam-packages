// Two synced "label" channels that ride the ordinary item pipeline exactly like
// the list registry (list-registry.mjs): reserved listId/listType buckets whose
// items carry the full base item shape — `text` string, `isDone:false`,
// `timeOfCompletion:0` — so an older peer's strict normalizeListItem accepts and
// stores them, plus a `labelName` field. A brand-new listType hits no existing
// apply()/reduce branch, so it cannot fork the base; it simply lands in a bucket
// older peers never render. Every surface's list filter must skip these types
// (use isLabelItem) so a label never shows up as a grocery row or a stray list.
//
//  • PEER labels: each device authors exactly ONE item, id = its own writerKey
//    (hex), advertising a human-readable device name to every peer. Self-asserted
//    — a device only ever writes its own key, so there is no contention; a rename
//    is an LWW update by updatedAt.
//  • SURFACE-NAME labels: the built-in surfaces (Groceries / Board / Todo) share
//    listId 'default' and so have no registry meta-item of their own. This channel
//    lets a rename of a built-in surface sync across devices, keyed by the surface
//    key `${listId}:${type}`. Anyone may rename; LWW by updatedAt.
//  • BUILTIN-GROUP labels: which user group each built-in surface belongs to.
//    Desktop used to keep this in device-local localStorage (preferences.
//    builtinGroups), so a fresh device never saw the placement; this channel
//    replicates it. Same surface key as the rename channel; the *value* is the
//    target groupId (parked in labelName). LWW by updatedAt.
//
// Empty name = cleared: the peer label disappears / the built-in reverts to its
// localized default. The reducers drop a newest-but-empty entry so a clear
// propagates without needing a tombstone.

// The synced presence/heartbeat channel lives in its own module; isLabelItem folds
// it in below so every projection/nav/stray-list gate that already calls isLabelItem
// skips presence too. One-directional: presence.mjs must NOT import labels.mjs.
import { isPresenceItem } from './presence.mjs'

export const PEER_LABEL_LIST_ID = '__peers__'
export const PEER_LABEL_LIST_TYPE = 'peer'
export const SURFACE_LABEL_LIST_ID = '__surfacenames__'
export const SURFACE_LABEL_LIST_TYPE = 'surfacename'
export const BUILTIN_GROUP_LIST_ID = '__builtingroups__'
export const BUILTIN_GROUP_LIST_TYPE = 'builtingroup'
// VALUE-RETURN labels: whether a surface has the optional "value return" property
// enabled (each item must be rated 1-10 value + 1-10 time-delay). Keyed by the
// same surface key as the rename/group channels so it works for built-in surfaces
// (which carry no registry meta-item) AND named lists, uniformly and synced. The
// *value* parked in labelName is '1' = enabled; empty = disabled (cleared).
export const VALUE_RETURN_LIST_ID = '__valuereturn__'
export const VALUE_RETURN_LIST_TYPE = 'valuereturn'

// Mirrors owner-control's device-name clamp; keeps a single grapheme-naive cap.
export const MAX_LABEL_NAME = 64

export function isPeerLabelItem (item) {
    return !!item && typeof item === 'object' && item.listType === PEER_LABEL_LIST_TYPE
}

export function isSurfaceLabelItem (item) {
    return !!item && typeof item === 'object' && item.listType === SURFACE_LABEL_LIST_TYPE
}

export function isBuiltinGroupItem (item) {
    return !!item && typeof item === 'object' && item.listType === BUILTIN_GROUP_LIST_TYPE
}

export function isValueReturnItem (item) {
    return !!item && typeof item === 'object' && item.listType === VALUE_RETURN_LIST_TYPE
}

// Any synced meta-item that must never render as a real list row or be picked up as
// a stray list by detectExtraLists / the nav library. Covers this module's label
// channels AND the presence/heartbeat channel (presence.mjs), so every existing
// gate that calls isLabelItem hides presence too. Kept separate from isRegistryItem
// so each predicate stays single-purpose.
export function isLabelItem (item) {
    return isPeerLabelItem(item) || isSurfaceLabelItem(item) || isBuiltinGroupItem(item)
        || isValueReturnItem(item) || isPresenceItem(item)
}

function numberOr (value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function cleanLabelName (name) {
    return typeof name === 'string' ? name.trim().slice(0, MAX_LABEL_NAME) : ''
}

// The stable id for a surface-name label: the built-in surface's (listId, type).
// Both desktop and mobile MUST compute this identically so a rename on one
// device targets the same label item on the other. Use the canonical type
// ('shopping' | 'board' | 'todo'), never the legacy board wire value.
export function surfaceLabelKey (listId, type) {
    const lid = typeof listId === 'string' && listId ? listId : ''
    const t = typeof type === 'string' ? type : ''
    return `${lid}:${t}`
}

function baseLabelItem ({ id, listId, listType, name, updatedAt }) {
    const clean = cleanLabelName(name)
    return {
        id,
        listId,
        listType,
        // Full base item shape so normalizeListItem (list-reducer.mjs) accepts it
        // on every peer, new or old. text mirrors labelName the way registry
        // items mirror regName into text.
        text: clean,
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: numberOr(updatedAt, 0),
        labelName: clean,
    }
}

// Build the synced item that advertises THIS device's name. `writerKey` is the
// device's own autobase writer key (hex); it is both the item id and a
// convenience field so a consumer that only has the item (not the roster) can
// still recover the key.
export function buildPeerLabelItem ({ writerKey, name, updatedAt }) {
    const key = String(writerKey ?? '')
    return { ...baseLabelItem({ id: key, listId: PEER_LABEL_LIST_ID, listType: PEER_LABEL_LIST_TYPE, name, updatedAt }), writerKey: key }
}

// Build the synced item that renames a built-in surface.
export function buildSurfaceLabelItem ({ listId, type, name, updatedAt }) {
    const key = surfaceLabelKey(listId, type)
    return { ...baseLabelItem({ id: key, listId: SURFACE_LABEL_LIST_ID, listType: SURFACE_LABEL_LIST_TYPE, name, updatedAt }), surfaceKey: key }
}

// Build the synced item that files a built-in surface into a user group. The
// *value* is the target groupId (parked in labelName the way a rename parks the
// name); an empty groupId clears the assignment so the surface falls back to the
// general/ungrouped group. Keyed by the same surface key as the rename channel,
// so desktop and mobile target the same item for a given (listId, type).
export function buildBuiltinGroupItem ({ listId, type, groupId, updatedAt }) {
    const key = surfaceLabelKey(listId, type)
    return { ...baseLabelItem({ id: key, listId: BUILTIN_GROUP_LIST_ID, listType: BUILTIN_GROUP_LIST_TYPE, name: groupId, updatedAt }), surfaceKey: key }
}

// Build the synced item that toggles the value-return property for a surface.
// `enabled` true parks '1' in labelName; false clears it (empty = disabled), so a
// disable propagates conflict-free without a tombstone. Keyed by surfaceLabelKey.
export function buildValueReturnItem ({ listId, type, enabled, updatedAt }) {
    const key = surfaceLabelKey(listId, type)
    return { ...baseLabelItem({ id: key, listId: VALUE_RETURN_LIST_ID, listType: VALUE_RETURN_LIST_TYPE, name: enabled ? '1' : '', updatedAt }), surfaceKey: key }
}

// Reduce label items to Map<id, name>: newest updatedAt wins per id; a newest
// entry whose name is empty is treated as "cleared" and produces no map entry.
// The item pipeline already LWW-merges by id, but reducing defensively here means
// the function is correct over any raw item list (full snapshot or otherwise).
function reduceLabels (items, predicate) {
    const newest = new Map() // id -> { name, at }
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!predicate(item)) continue
        const id = typeof item.id === 'string' ? item.id : null
        if (!id) continue
        const at = numberOr(item.updatedAt, 0)
        const prev = newest.get(id)
        if (prev && prev.at >= at) continue
        const name = cleanLabelName(typeof item.labelName === 'string' ? item.labelName : item.text)
        newest.set(id, { name, at })
    }
    const out = new Map()
    for (const [id, entry] of newest) if (entry.name) out.set(id, entry.name)
    return out
}

// Map<writerKeyHex, deviceName> over a flat item list.
export function reducePeerLabels (items) {
    return reduceLabels(items, isPeerLabelItem)
}

// Map<surfaceKey, name> over a flat item list, where surfaceKey === surfaceLabelKey(listId, type).
export function reduceSurfaceLabels (items) {
    return reduceLabels(items, isSurfaceLabelItem)
}

// Map<surfaceKey, groupId> over a flat item list — which group each built-in
// surface belongs to. An empty value = cleared (no entry), so the consumer
// falls back to its general/ungrouped group.
export function reduceBuiltinGroups (items) {
    return reduceLabels(items, isBuiltinGroupItem)
}

// Map<surfaceKey, true> of surfaces that have value-return enabled. An empty
// value = cleared (no entry), so a disable simply drops the surface from the map.
export function reduceValueReturn (items) {
    const out = new Map()
    for (const key of reduceLabels(items, isValueReturnItem).keys()) out.set(key, true)
    return out
}
