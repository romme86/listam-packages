// Owner-mediated epoch-key repair during a normal frontend resync.
//
// Epoch list operations cannot carry a replacement key: a stale peer could not
// decrypt that operation. Instead the owner appends a signed membership record
// containing a sealed grant for every currently-authorized writer, followed by
// merge-safe item repairs encrypted with the granted key. Repairs MUST be
// individual upserts: a whole-list snapshot clears the bucket in the reducer,
// so a stale owner snapshot linearized after a peer add can erase that add.
// Removed writers are absent from membershipState.writers and therefore never
// receive a grant.

import {
    canCreateMembershipInvite,
    createEpochResyncMembershipRecord,
    nextMembershipSequence,
    RESYNC_EPOCH_ACTION,
} from './membership.mjs'
import { createEpochGrants } from './key-epochs.mjs'
import { createListOperation } from './list-reducer.mjs'

export async function performEpochResync(deps) {
    const {
        autobase,
        epochKey,
        membershipState,
        ownerAuthorityKeyPair,
        getAllItems,
        prepareListAppendOperation,
        publishGrant = null,
        enqueueWrite = (fn) => fn(),
        waitForFlushableWriter = async () => true,
        logger,
    } = deps

    if (!autobase?.writable) return skipped('not-writable')
    if (!epochKey) return skipped('missing-epoch-key')
    if (!canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) return skipped('not-owner')

    const ownerWriterKey = membershipState.ownerWriterKey
    const epoch = Number(membershipState.currentEpoch) || 0
    if (!ownerWriterKey || epoch <= 0) return skipped('incomplete-membership')

    const recipients = [...membershipState.writers].map((writerKey) => ({
        writerKey,
        epochPublicKey: membershipState.writerEpochPublicKeys.get(writerKey),
    }))
    if (recipients.length <= 1) return skipped('no-peer-writers')
    if (recipients.some((recipient) => !recipient.epochPublicKey)) {
        return skipped('missing-epoch-public-key')
    }

    const epochGrants = createEpochGrants({ epochKey, recipients })
    if (epochGrants.length !== recipients.length) return skipped('incomplete-epoch-grants')

    const membershipRecord = createEpochResyncMembershipRecord({
        ownerAuthorityKeyPair,
        writerKey: ownerWriterKey,
        baseKey: autobase.key,
        sequence: nextMembershipSequence(membershipState),
        epoch,
        epochKey,
        epochGrants,
    })

    let snapshotCount = 0
    let grantDelivery = null
    let flushable = true
    try {
        await enqueueWrite(async () => {
            // The repair shares the normal mutation queue. Never start an
            // Autobase append unless the local writer can flush: append may
            // otherwise retry forever and hold every subsequent edit behind it.
            if (!(await waitForFlushableWriter())) {
                flushable = false
                return
            }
            // Capture the owner's complete materialized state inside the same
            // serialized write unit. Each item becomes an idempotent LWW upsert
            // immediately after peers adopt the sealed key grant. A peer add
            // absent from this capture remains untouched.
            const allItems = await getAllItems()
            const repairs = buildRepairOperations(allItems)

            await autobase.append(membershipRecord)
            await autobase.update()

            // A peer whose old reducer already discarded the new membership
            // action cannot recover by replaying the derived Autobase view.
            // Deliver the same signed + sealed record on the Noise control
            // channel and wait for adoption before publishing repairs, so
            // those repairs are decryptable on their first application.
            if (typeof publishGrant === 'function') {
                grantDelivery = await publishGrant(membershipRecord)
            }

            for (const operation of repairs) {
                const encrypted = prepareListAppendOperation(operation)
                if (!encrypted) throw new Error('Could not encrypt epoch resync repair')
                await autobase.append(encrypted)
                snapshotCount++
            }
            if (snapshotCount > 0) await autobase.update()
        })
    } catch (error) {
        logger?.log?.('[ERROR] Epoch resync grant failed:', error)
        return { ok: false, skipped: false, reason: 'write-failed', snapshotCount: 0, grantDelivery, grantRecord: null }
    }
    if (!flushable) return skipped('sync-stalled')

    logger?.log?.('[AUDIT] Re-granted current epoch to active writers during resync', {
        epoch,
        recipients: recipients.length,
        snapshotCount,
    })
    return { ok: true, skipped: false, reason: null, snapshotCount, grantDelivery, grantRecord: membershipRecord }
}

function buildRepairOperations(items) {
    return (Array.isArray(items) ? items : [])
        .map((item) => createListOperation('update', item))
        .filter(Boolean)
}

// A cached direct grant is reusable for reconnecting peers only while it still
// names the exact active writer set and current epoch. Any add/remove/rekey makes
// it stale and forces one new signed record; ordinary reconnects do not append.
export function epochResyncRecordMatchesMembership(record, state) {
    if (record?.action !== RESYNC_EPOCH_ACTION) return false
    if (record?.writerKey !== state?.ownerWriterKey) return false
    if (Number(record?.epoch) !== Number(state?.currentEpoch)) return false

    const writers = state?.writers instanceof Set ? state.writers : new Set()
    const granted = new Set(
        (Array.isArray(record?.epochGrants) ? record.epochGrants : [])
            .map((grant) => grant?.writerKey)
            .filter(Boolean),
    )
    return granted.size === writers.size && [...writers].every((writerKey) => granted.has(writerKey))
}

function skipped(reason) {
    return { ok: false, skipped: true, reason, snapshotCount: 0, grantDelivery: null, grantRecord: null }
}
