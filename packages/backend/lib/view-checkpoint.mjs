// Materialized-view checkpoint over the linearized Autobase view.
//
// The view is the durable op log (list operations plus persisted membership
// records). Before this checkpoint existed, every rebuild re-read the view
// from index 0 — O(n) per call, and the join flow polls a rebuild every
// second for up to two minutes (O(n·attempts), the "full-view replay"
// finding). The checkpoint holds the id-keyed reduction state and the scan
// position, so each pass reads only entries appended since the last pass.
//
// Autobase may truncate or reorder the linearized view when the writer set
// or causal ordering changes, so a checkpoint is only trusted after
// re-reading the last entry it processed and matching it against what the
// view holds at that index now. Any mismatch (shorter view, changed entry,
// failed read) falls back to a full replay from index 0 — resuming is an
// optimization, never an assumption.
import { createListReduction } from './list-reducer.mjs'

export function createViewCheckpoint() {
    let reduction = createListReduction()
    let membershipRecords = []
    let processedLength = 0
    let lastEntryJson = null

    function reset() {
        reduction = createListReduction()
        membershipRecords = []
        processedLength = 0
        lastEntryJson = null
    }

    async function canResume(view) {
        if (processedLength === 0) return false
        if (!view || view.length < processedLength) return false

        let tail = null
        try {
            tail = await view.get(processedLength - 1)
        } catch {
            return false
        }
        return JSON.stringify(tail ?? null) === lastEntryJson
    }

    // Scan the view and return the reduced list plus the membership records
    // seen so far. `onError(index, error)` reports unreadable entries; the
    // scan skips them (matching the previous full-replay behavior) and a
    // later pass self-corrects via the resume verification above.
    async function update(view, { onError } = {}) {
        if (!view) {
            return { items: reduction.items(), membershipRecords: [...membershipRecords], resumedFrom: processedLength, scanned: 0 }
        }

        const resumed = await canResume(view)
        if (!resumed) reset()
        const start = processedLength
        let scanned = 0

        for (let i = start; i < view.length; i++) {
            let entry = null
            try {
                entry = await view.get(i)
            } catch (error) {
                onError?.(i, error)
            }
            scanned++
            if (entry && entry.op === 'membership') {
                if (entry.record) membershipRecords.push(entry.record)
            } else if (entry) {
                reduction.applyEntry(entry)
            }
            lastEntryJson = JSON.stringify(entry ?? null)
            processedLength = i + 1
        }

        return {
            items: reduction.items(),
            membershipRecords: [...membershipRecords],
            resumedFrom: start,
            scanned,
        }
    }

    return { update, reset }
}
