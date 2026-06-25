// Self-heal planner for a list orphaned by an unreachable shared base.
//
// Background: a list's registry entry can point its items at a separate shared
// base (regBaseKey). shareList moves the items into that base and tombstones the
// personal copies. If the shared base can never be opened on this device (no
// local storage AND no propagated read-credentials — e.g. it was created by a
// peer that is gone, or its local copy was lost), the list's data is stranded
// and the list renders empty. When the original items still live in the durable
// personal log as tombstones, we can re-point the list at the personal base and
// resurrect them.
//
// This module is PURE: callers pass plain data + predicate callbacks, so the
// decision logic is fully unit-testable without a live Autobase. The thin
// backend wrapper supplies the live inputs and applies the returned plans.

// Decide which orphaned shared lists to heal and which items to resurrect.
//
//   lists        reduced registry lists: [{ id, name, type, groupId, order, view, baseKey }]
//   isBaseOpen   (baseKey) => boolean   the shared base is currently open here
//   hasCreds     (baseKey) => boolean   propagated auto-join read-credentials exist
//   hasLocalDir  (baseKey) => boolean   a local shared-storage dir exists for it
//   isHealed     (baseKey) => boolean   already healed (device-local marker)
//   liveCount    (listId)  => number    live (non-tombstoned) items for the list
//   tombstoned   (listId)  => item[]    recoverable tombstoned items for the list
//
// A list is healed ONLY when ALL hold, so a healthy or in-flight-join list is
// never touched:
//   - it is a shared list (has a baseKey)
//   - the base is NOT open, has NO propagated creds (so it is not a cross-device
//     auto-join still settling), and has NO local storage dir
//   - it has not already been healed
//   - it has ZERO live items (its data really is stranded, not partially deleted)
//   - it has at least one recoverable tombstoned item carrying text
export function planOrphanedListHeals ({
    lists,
    isBaseOpen,
    hasCreds,
    hasLocalDir,
    isHealed,
    liveCount,
    tombstoned,
}) {
    const plans = []
    for (const l of Array.isArray(lists) ? lists : []) {
        if (!l || typeof l.id !== 'string' || !l.baseKey) continue
        if (isBaseOpen(l.baseKey) || hasCreds(l.baseKey) || hasLocalDir(l.baseKey) || isHealed(l.baseKey)) continue
        if (liveCount(l.id) > 0) continue
        const items = (tombstoned(l.id) || []).filter(
            (it) => it && typeof it.id === 'string' && it.id && typeof it.text === 'string',
        )
        if (items.length === 0) continue
        plans.push({ listId: l.id, baseKey: l.baseKey, list: l, items })
    }
    return plans
}

// Reduce a flat list-operation log into the set of items that are currently
// TOMBSTONED (deleted with no surviving live copy), keyed by listId then id,
// carrying each item's last-known full payload (from its latest add/update).
// `entries` are materialized-view entries shaped like createListViewEntry output
// ({ op, listId, listType, items?, item?, id?, ...itemFields }).
export function tombstonedFromLog (entries) {
    const byList = new Map() // listId -> Map<id, { item, deleted }>
    const note = (item, deleted) => {
        if (!item || typeof item.id !== 'string' || !item.id || typeof item.listId !== 'string') return
        let m = byList.get(item.listId)
        if (!m) { m = new Map(); byList.set(item.listId, m) }
        const cur = m.get(item.id) || { item: null, deleted: false }
        if (deleted) cur.deleted = true
        else { cur.deleted = false; cur.item = { ...item } }
        m.set(item.id, cur)
    }
    for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || e.op === 'membership' || e.op === 'board-config') continue
        if (e.op === 'list' && Array.isArray(e.items)) {
            for (const it of e.items) note(it, false)
        } else if (e.op === 'add' || e.op === 'update') {
            const it = { ...e }
            delete it.op
            delete it.version
            note(it, false)
        } else if (e.op === 'delete') {
            note(e.item || { id: e.id, listId: e.listId, listType: e.listType, text: e.text }, true)
        }
    }
    const out = new Map() // listId -> Map<id, item>
    for (const [listId, m] of byList) {
        const t = new Map()
        for (const [id, v] of m) if (v.deleted && v.item) t.set(id, v.item)
        if (t.size) out.set(listId, t)
    }
    return out
}
