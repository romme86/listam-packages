// Materialized-view checkpoint over the linearized Autobase view.
//
// The view is the durable op log (list operations plus persisted control
// records: membership and board-config). Before this checkpoint existed, every
// rebuild re-read the view from index 0 — O(n) per call, and the join flow
// polls a rebuild every second for up to two minutes (O(n·attempts), the
// "full-view replay" finding). The checkpoint holds the id-keyed reduction
// state and the scan position, so each pass reads only entries appended since
// the last pass.
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
    let boardConfigRecords = []
    let compactionRecords = []
    let processedLength = 0
    let lastEntryJson = null

    function reset() {
        reduction = createListReduction()
        membershipRecords = []
        boardConfigRecords = []
        compactionRecords = []
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

    // Scan the view and return the reduced list plus the control records seen
    // so far. `onError(index, error)` reports unreadable entries; the scan
    // reports a partial result for diagnostics, then resets so a later pass
    // retries the full view instead of checkpointing past a missing entry.
    async function update(view, { onError } = {}) {
        if (!view) {
            return {
                items: reduction.items(),
                allItems: reduction.allItems(),
                membershipRecords: [...membershipRecords],
                boardConfigRecords: [...boardConfigRecords],
                compactionRecords: [...compactionRecords],
                resumedFrom: processedLength,
                scanned: 0,
                complete: true,
            }
        }

        const resumed = await canResume(view)
        if (!resumed) reset()
        const start = processedLength
        let scanned = 0
        let complete = true

        for (let i = start; i < view.length; i++) {
            let entry = null
            try {
                entry = await view.get(i)
            } catch (error) {
                complete = false
                onError?.(i, error)
            }
            scanned++
            if (entry && entry.op === 'membership') {
                if (entry.record) membershipRecords.push(entry.record)
            } else if (entry && entry.op === 'board-config') {
                if (entry.record) boardConfigRecords.push(entry.record)
            } else if (entry && entry.op === 'compaction') {
                if (entry.record) compactionRecords.push(entry.record)
            } else if (entry) {
                reduction.applyEntry(entry)
            }
            lastEntryJson = JSON.stringify(entry ?? null)
            processedLength = i + 1
        }

        const result = {
            items: reduction.items(),
            allItems: reduction.allItems(),
            membershipRecords: [...membershipRecords],
            boardConfigRecords: [...boardConfigRecords],
            compactionRecords: [...compactionRecords],
            resumedFrom: start,
            scanned,
            complete,
        }
        // Never checkpoint past an unreadable middle entry. Returning the
        // partial reduction lets diagnostic callers inspect what was readable,
        // but the next pass must retry the whole view instead of treating the
        // missing row as durably absent.
        if (!complete) reset()
        return result
    }

    return { update, reset }
}
