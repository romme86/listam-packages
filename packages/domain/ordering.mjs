// Manual item ordering — a conflict-free way to let users reorganize the order
// of items inside any list (grocery, todo, board column, …).
//
// Every list item may carry an optional numeric `order` field. It rides along
// on the item through the normal add/update pipeline (last-write-wins by
// `updatedAt`, exactly like every other field), so reordering needs no new wire
// type and old peers sync it untouched — they just ignore a field they don't
// render. This mirrors the registry's `regOrder` pattern, but per item.
//
// Display rule (`sortByOrder`): items WITH an order sort ascending by it; items
// WITHOUT one are treated as "not yet placed" and float to the TOP in their
// incoming (insertion) order. A list nobody has reordered therefore renders
// exactly as before — order is purely additive.
//
// A reorder is a single LWW write to the moved item (midpoint between its new
// neighbours, `computeReorder`). Two peers moving DIFFERENT items never
// conflict; moving the SAME item resolves by `updatedAt`. When neighbours have
// no order yet (first reorder of a list) or fractional midpoints collapse past
// float precision, we renormalize the whole group to evenly spaced integers and
// emit only the items whose order actually changed.

// Spacing used when (re)materializing a clean baseline. Large enough to leave
// room for many midpoint inserts before a renormalize is needed.
export const ORDER_STEP = 1000

// Below this gap between neighbours a midpoint is too close to represent
// reliably, so we renormalize instead.
const ORDER_MIN_GAP = 1e-6

// The item's order as a usable number, or null when it has none / it's junk.
export function orderOf (item) {
    const value = item?.order
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// True once any item in the group carries an explicit order.
export function hasExplicitOrder (items) {
    return Array.isArray(items) && items.some((item) => orderOf(item) !== null)
}

// Stable display sort. Unordered items keep their incoming relative order and
// sit at the top; ordered items follow, ascending by `order`.
export function sortByOrder (items) {
    if (!Array.isArray(items)) return []
    return items
        .map((item, index) => ({ item, index, order: orderOf(item) }))
        .sort((a, b) => {
            if (a.order === null && b.order === null) return a.index - b.index
            if (a.order === null) return -1
            if (b.order === null) return 1
            if (a.order !== b.order) return a.order - b.order
            return a.index - b.index
        })
        .map((entry) => entry.item)
}

// A new order strictly between two neighbour orders (either may be null for the
// top/bottom edge of the group).
export function orderBetween (before, after) {
    if (before === null && after === null) return ORDER_STEP
    if (before === null) return after - ORDER_STEP
    if (after === null) return before + ORDER_STEP
    return (before + after) / 2
}

function gapOk (before, after, value) {
    if (!Number.isFinite(value)) return false
    if (before !== null && Math.abs(value - before) < ORDER_MIN_GAP) return false
    if (after !== null && Math.abs(after - value) < ORDER_MIN_GAP) return false
    return true
}

// Evenly spaced orders for a whole sequence — used to establish or repair a
// clean baseline. Returns the items that actually need rewriting (order changed)
// with their new `order` set.
export function renormalizeOrders (orderedItems) {
    if (!Array.isArray(orderedItems)) return []
    const updates = []
    orderedItems.forEach((item, index) => {
        const order = (index + 1) * ORDER_STEP
        if (orderOf(item) !== order) updates.push({ ...item, order })
    })
    return updates
}

// Compute the writes needed to move the item at `fromIndex` to `toIndex` within
// a group's current display-ordered array. Returns `{ updates, renormalized }`
// where `updates` is the list of items (copies) whose `order` changed — the
// caller is responsible for bumping `updatedAt` and sending each one. Usually a
// single update (the moved item); a whole-group renormalize when a clean
// baseline is required.
export function computeReorder (orderedItems, fromIndex, toIndex) {
    if (!Array.isArray(orderedItems)) return { updates: [], renormalized: false }
    const n = orderedItems.length
    if (fromIndex < 0 || fromIndex >= n) return { updates: [], renormalized: false }

    const dest = Math.max(0, Math.min(n - 1, toIndex))
    if (dest === fromIndex) return { updates: [], renormalized: false }

    const seq = orderedItems.slice()
    const [moved] = seq.splice(fromIndex, 1)
    seq.splice(dest, 0, moved)

    const pos = seq.indexOf(moved)
    const before = pos > 0 ? orderOf(seq[pos - 1]) : null
    const after = pos < seq.length - 1 ? orderOf(seq[pos + 1]) : null

    // A null neighbour that isn't simply the group edge means that neighbour has
    // no order yet — we can't midpoint against it, so renormalize.
    const missingNeighbour =
        (pos > 0 && before === null) ||
        (pos < seq.length - 1 && after === null)

    if (!missingNeighbour) {
        const next = orderBetween(before, after)
        if (gapOk(before, after, next)) {
            return { updates: [{ ...moved, order: next }], renormalized: false }
        }
    }

    return { updates: renormalizeOrders(seq), renormalized: true }
}
