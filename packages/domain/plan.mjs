// The "day plan" channel — one synced meta-item bucket that rides the ordinary
// item pipeline exactly like the list registry (list-registry.mjs) and the label
// channels (labels.mjs): a reserved listId/listType whose items carry the full
// base item shape — `text` string, `isDone:false`, `timeOfCompletion:0` — so an
// older peer's strict normalizeListItem accepts and stores them. The brand-new
// listType hits no existing apply()/reduce branch, so it cannot fork the base; it
// simply lands in a bucket older peers never render. Every surface's list filter
// MUST skip this type (use isPlanItem) so a plan entry never shows up as a
// grocery row or a stray list.
//
// A plan entry is a POINTER, never a copy: it references a source item (or a
// whole list) and a day. The Overview joins these refs back to the live source
// items, so marking-done / editing in the Overview is just a normal RPC_UPDATE on
// the *source* item — the plan entry holds no item text or done-state of its own.
//
//  • ITEM ref:  id = `i:<listId>::<itemId>`, planKind 'item'. Flag a single item
//    into a day's plan.
//  • LIST ref:  id = `l:<listId>`, planKind 'list'. Flag a whole list; the
//    Overview renders it as a "list card" (open-only, not editable). Checking a
//    list card clears it from the plan.
//
// `plannedFor` is a local date key ('YYYY-MM-DD'); `planOrder` is the per-day
// manual sort order (rides ordering.mjs). Empty `plannedFor` = cleared: the
// reducer drops a newest-but-empty entry so an unflag / clear-from-plan
// propagates conflict-free without a tombstone (mirrors labels' empty-name-clears).
// Two devices flagging different items never conflict; the same ref resolves LWW
// by updatedAt.

import { sortByOrder, computeReorder } from './ordering.mjs'

export const PLAN_LIST_ID = '__plan__'
export const PLAN_LIST_TYPE = 'plan'

export const PLAN_KIND_ITEM = 'item'
export const PLAN_KIND_LIST = 'list'

function numberOr (value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str (value) {
    return typeof value === 'string' ? value : ''
}

export function isPlanItem (item) {
    return !!item && typeof item === 'object' && item.listType === PLAN_LIST_TYPE
}

// Deterministic plan ids. Both desktop and mobile MUST compute these identically
// so a flag on one device targets the same plan entry on the other (LWW by id).
export function planItemKey (listId, itemId) {
    return `i:${str(listId)}::${str(itemId)}`
}

// A list plan-ref keyed by (listId, surface type). The built-in surfaces
// (Groceries / Board / Todo) share listId 'default', so the type disambiguates
// which surface was flagged. Registry lists pass their own (unique) type.
export function planListKey (listId, listType = '') {
    const lid = str(listId)
    const t = str(listType)
    return t ? `l:${lid}::${t}` : `l:${lid}`
}

// Local date key 'YYYY-MM-DD' for an epoch-ms instant. Deterministic given ms.
export function toDateKey (ms) {
    const d = new Date(numberOr(ms, 0))
    if (Number.isNaN(d.getTime())) return ''
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

// Shift a date key by `days` (local calendar days). Used to build the 7-day strip
// and "tomorrow" without re-deriving from ms. Returns '' for a malformed key.
export function shiftDateKey (dateKey, days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(dateKey))
    if (!m) return ''
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + numberOr(days, 0))
    return toDateKey(d.getTime())
}

// Build the synced plan entry. `plannedFor` of '' clears the entry. The base
// shape (text/isDone/timeOfCompletion) is present so normalizeListItem accepts it
// on every peer; all plan fields are namespaced so they never collide.
export function buildPlanItem ({ id, kind, refListId, refItemId, refType, plannedFor, planOrder, updatedAt }) {
    const planRef = str(id)
    return {
        id: planRef,
        listId: PLAN_LIST_ID,
        listType: PLAN_LIST_TYPE,
        text: planRef,
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: numberOr(updatedAt, 0),
        planKind: kind === PLAN_KIND_LIST ? PLAN_KIND_LIST : PLAN_KIND_ITEM,
        planRefListId: str(refListId),
        planRefItemId: str(refItemId),
        // For a LIST ref, the flagged surface's type (built-ins share a listId);
        // for an ITEM ref the source item already carries its own listType.
        planRefType: str(refType),
        plannedFor: str(plannedFor),
        planOrder: numberOr(planOrder, 0),
    }
}

// Convenience builders for the two flag actions.
export function buildItemPlanEntry ({ listId, itemId, plannedFor, planOrder, updatedAt }) {
    return buildPlanItem({
        id: planItemKey(listId, itemId),
        kind: PLAN_KIND_ITEM,
        refListId: listId,
        refItemId: itemId,
        plannedFor,
        planOrder,
        updatedAt,
    })
}

export function buildListPlanEntry ({ listId, listType, plannedFor, planOrder, updatedAt }) {
    return buildPlanItem({
        id: planListKey(listId, listType),
        kind: PLAN_KIND_LIST,
        refListId: listId,
        refItemId: '',
        refType: listType,
        plannedFor,
        planOrder,
        updatedAt,
    })
}

// Reduce plan items to Map<planRef, record>: newest updatedAt wins per id; a
// newest entry whose plannedFor is empty is treated as "cleared" and produces no
// map entry. Correct over any raw item list (full snapshot or partial).
export function reducePlan (items) {
    const newest = new Map() // ref -> { rec, at }
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!isPlanItem(item)) continue
        const ref = typeof item.id === 'string' ? item.id : null
        if (!ref) continue
        const at = numberOr(item.updatedAt, 0)
        const prev = newest.get(ref)
        if (prev && prev.at >= at) continue
        newest.set(ref, {
            at,
            rec: {
                ref,
                kind: item.planKind === PLAN_KIND_LIST ? PLAN_KIND_LIST : PLAN_KIND_ITEM,
                refListId: str(item.planRefListId),
                refItemId: str(item.planRefItemId),
                refType: str(item.planRefType),
                plannedFor: str(item.plannedFor),
                planOrder: numberOr(item.planOrder, 0),
                updatedAt: at,
            },
        })
    }
    const out = new Map()
    for (const [ref, entry] of newest) if (entry.rec.plannedFor) out.set(ref, entry.rec)
    return out
}

// Group reduced plan records by their date key, each day's array sorted by
// planOrder (ordering.mjs display rule). Returns Map<dateKey, record[]>.
export function groupPlanByDate (reduced) {
    const byDate = new Map()
    const values = reduced instanceof Map ? [...reduced.values()] : (Array.isArray(reduced) ? reduced : [])
    for (const rec of values) {
        if (!rec || !rec.plannedFor) continue
        if (!byDate.has(rec.plannedFor)) byDate.set(rec.plannedFor, [])
        byDate.get(rec.plannedFor).push(rec)
    }
    for (const [date, recs] of byDate) {
        const sorted = sortByOrder(recs.map((r) => ({ ...r, order: numberOr(r.planOrder, 0) })))
            .map(({ order, ...rest }) => rest)
        byDate.set(date, sorted)
    }
    return byDate
}

// Compute the planOrder writes to move a record within one day's ordered array.
// Returns { updates: [{ ref, planOrder }], renormalized } — the caller rebuilds
// each plan entry (buildPlanItem) with the new planOrder + a fresh updatedAt and
// sends RPC_UPDATE. Thin wrapper over ordering.mjs computeReorder (planOrder↔order).
export function computePlanReorder (orderedRecords, fromIndex, toIndex) {
    const seq = (Array.isArray(orderedRecords) ? orderedRecords : [])
        .map((r) => ({ ...r, order: numberOr(r.planOrder, 0) }))
    const { updates, renormalized } = computeReorder(seq, fromIndex, toIndex)
    return {
        updates: updates.map((u) => ({ ref: u.ref, planOrder: u.order })),
        renormalized,
    }
}
