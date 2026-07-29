// Minting a compaction barrier: the owner-side half of lib/compaction.mjs.
//
// Kept out of network.mjs so the ordering rules below are unit-testable without
// booting the whole P2P graph — the same reason rekey.mjs exists.
//
// TWO ORDERING RULES, both load-bearing:
//
//  1. The clock is read BEFORE the snapshot is appended. The snapshot ops must
//     land above their own barrier, or the barrier would suppress the very
//     snapshot that replaces the history it suppresses. Anything another writer
//     appends in that window is also above the clock, so it survives — which is
//     the same property that protects a concurrent writer generally.
//
//  2. The barrier is appended AFTER the snapshot, and only if every snapshot
//     group landed. A barrier without its snapshot is data loss, not compaction.
import { buildCompactionSnapshot, clockFromHeads, createCompactionRecord, snapshotDigestHex } from './compaction.mjs'
import { canCreateMembershipInvite, nextMembershipSequence } from './membership.mjs'
import { createListOperation } from './list-reducer.mjs'

export async function performCompaction({
    autobase,
    ownerAuthorityKeyPair,
    membershipState,
    compactionState,
    getAllItems,
    prepareListAppendOperation,
    enqueueWrite = async (fn) => fn(),
    readiness,
    logger = { log: () => {} },
    now = Date.now,
} = {}) {
    if (!autobase?.writable) return refused('not-writable')
    if (!canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) return refused('not-owner')

    // The mesh-readiness gate. Compaction cannot fork a peer that ignores the
    // barrier, but it DOES leave such a peer doing the full replay forever, and
    // the owner is still making a project-wide call — so make it from observed
    // capability rather than from a note. See @listam/domain/presence.
    if (!readiness?.ready) {
        logger.log('[WARNING] Compaction refused; not every device reports support', {
            ready: readiness?.readyCount ?? 0,
            total: readiness?.total ?? 0,
        })
        return refused('mesh-not-ready', { readiness })
    }

    const epoch = Number(membershipState?.currentEpoch) || 0
    if (epoch <= 0) return refused('no-epoch')

    let result = refused('failed')

    await enqueueWrite(async () => {
        // Rule 1: the clock is the frontier as it stands BEFORE the snapshot.
        const clock = clockFromHeads(autobase.system?.heads)
        if (!clock.length) {
            result = refused('no-clock')
            return
        }

        // Read the items fresh inside the serialized unit so the snapshot
        // reflects every write ordered before it, not a copy captured when the
        // request arrived.
        const allItems = await getAllItems()
        const groups = buildCompactionSnapshot(allItems)
        if (!groups.length) {
            result = refused('nothing-to-compact')
            return
        }

        try {
            for (const group of groups) {
                const op = createListOperation('list', group.items, {
                    listId: group.listId,
                    listType: group.listType,
                })
                await autobase.append(prepareListAppendOperation(op))
            }
            await autobase.update()
        } catch (e) {
            logger.log('[ERROR] Compaction snapshot append failed; no barrier written', e)
            result = refused('snapshot-failed')
            return
        }

        // Rule 2: only now, with the snapshot durably appended.
        try {
            const record = createCompactionRecord({
                ownerAuthorityKeyPair,
                baseKey: autobase.key,
                sequence: Math.max(
                    Number(compactionState?.sequence) || 0,
                    nextMembershipSequence(membershipState) - 1,
                ) + 1,
                epoch,
                snapshotDigest: snapshotDigestHex(allItems),
                clock,
                createdAt: now(),
            })
            await autobase.append(record)
            await autobase.update()
            logger.log('[AUDIT] History compacted', {
                epoch,
                sequence: record.sequence,
                buckets: groups.length,
                items: allItems.length,
            })
            result = { ok: true, reason: null, sequence: record.sequence, buckets: groups.length, items: allItems.length }
        } catch (e) {
            // The snapshot is already in the log. That is harmless on its own —
            // it is an ordinary full-list write every peer applies — so this
            // degrades to "not compacted", never to lost data.
            logger.log('[ERROR] Compaction barrier append failed; snapshot stands but history is not compacted', e)
            result = refused('barrier-failed')
        }
    })

    return result
}

function refused(reason, extra = {}) {
    return { ok: false, reason, ...extra }
}
