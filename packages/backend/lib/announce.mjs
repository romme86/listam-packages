// What the frontend has been TOLD exists — so it can be corrected when Autobase
// discards an operation that apply already announced.
//
// apply emits an RPC frame the moment it admits an operation. Autobase may then
// reorder history, truncate the view, re-run apply, and REFUSE that same
// operation (see apply-discard-reorder.test.mjs). The view is rolled back; the
// frame is not. The row stays on screen and lives on no peer.
//
// This is the smallest structure that closes that gap: the ids apply has
// announced, with just enough of each to retract it. After a reorg, any
// announced id the committed view does not contain is a phantom.
//
// SCOPE, stated rather than implied. This corrects ONLY announced-then-discarded.
// It deliberately does not try to be a general view-to-frontend differ:
//   - an operation refused in one pass and admitted in a later one needs no
//     help, because the re-apply emits it again;
//   - an item whose LWW winner changed across a reorg is likewise re-emitted by
//     the re-apply.
// The rolled-back announcement is the one case nothing else corrects, and it is
// the only case handled here. Keeping the normal emission path untouched is
// deliberate too: it leaves frame ordering for the three clients exactly as it
// is today, so this cannot regress them.
//
// apply runs phantoms() at the end of EVERY pass rather than trying to detect a
// reorg first (see the call site for why detection does not work). Measured on
// this machine, the steady-state pass where nothing is a phantom costs
// 0.021 ms at 1k announced rows, 0.078 ms at 5k, 0.342 ms at 20k — against the
// millisecond-scale work already in apply, and against the ~5 ms/edit the
// clients spend at 5k items after Release 4.

// The minimum a client needs to drop a row: it keys by id and buckets by
// (listId, listType). Storing this, rather than the whole item, keeps the log
// small enough to hold for every announced row.
export function retractionPayload (item) {
    if (!item || typeof item !== 'object') return null
    const id = typeof item.id === 'string' ? item.id : null
    if (!id) return null
    return {
        id,
        listId: item.listId ?? null,
        listType: item.listType ?? null,
    }
}

export function committedItemIds (items) {
    const ids = new Set()
    for (const item of Array.isArray(items) ? items : []) {
        if (item && typeof item.id === 'string') ids.add(item.id)
    }
    return ids
}

export function createAnnouncementLog () {
    const announced = new Map()

    return {
        get size () { return announced.size },

        // An ADD/UPDATE frame asserts the row exists.
        note (item) {
            const payload = retractionPayload(item)
            if (payload) announced.set(payload.id, payload)
        },

        // A DELETE frame withdraws that assertion, so the row is no longer ours
        // to retract.
        forget (id) {
            if (typeof id === 'string') announced.delete(id)
        },

        has (id) { return announced.has(id) },

        clear () { announced.clear() },

        // Announced rows the committed view does not contain. Pure — the caller
        // decides what to emit and calls forget().
        //
        // Only ids THIS log announced are ever returned, so a row the frontend
        // learned about some other way (boot projection, SYNC_LIST) can never be
        // retracted by mistake.
        phantoms (committedIds) {
            const out = []
            if (!(committedIds instanceof Set)) return out
            for (const [id, payload] of announced) {
                if (!committedIds.has(id)) out.push(payload)
            }
            return out
        },
    }
}
