// Member-removal re-key orchestration (Phase 4, finding C1).
//
// Extracted from network.mjs so the flow — including its rollback and
// partial-failure paths — is testable without importing the BareKit-bound
// backend.mjs/network.mjs graph (same pattern as join-rollback.mjs). The pure
// crypto/record helpers are imported directly; everything stateful or
// side-effecting (the autobase handle, the current epoch/membership state, and
// the persistence setters) is injected so tests can drive every branch.

import {
    canCreateMembershipInvite,
    cloneMembershipState,
    createRemoveWriterMembershipRecord,
    nextMembershipSequence,
} from './membership.mjs'
import {
    createEpochGrants,
    epochKeyHashHex,
    generateEpochKey as defaultGenerateEpochKey,
} from './key-epochs.mjs'
import { createListOperation } from './list-reducer.mjs'

const HEX = /^[0-9a-f]+$/i
const WRITER_KEY_BYTES = 32
// The membership removal + epoch advance are append-only and irreversible once
// committed, so the only thing that can fail recoverably after the commit is the
// re-encrypted snapshot. Retry it a few times before giving up.
const DEFAULT_SNAPSHOT_RETRIES = 2

// Remove a writer from the project and rotate the list epoch key so the removed
// device can no longer decrypt or append in the new epoch.
//
// Returns a result object rather than a bare boolean so the caller (and tests)
// can tell the three meaningfully different outcomes apart:
//   - { ok: false, committed: false }            — rejected/failed before the
//       membership record committed; the previous epoch is fully restored.
//   - { ok: true,  committed: true, snapshot: true }   — full success.
//   - { ok: true,  committed: true, snapshot: false }  — the member was removed
//       and the epoch advanced (the security goal is met and irreversible), but
//       the re-encrypted snapshot did not persist. Existing members are
//       unaffected; writers that JOIN AFTER this re-key may need a manual sync
//       until a fresh snapshot lands. This is surfaced loudly, never silently.
export async function performMemberRemovalRekey(writerKey, deps) {
    const {
        autobase,
        epochKey,
        membershipState,
        ownerAuthorityKeyPair,
        getCurrentList,
        prepareListAppendOperation,
        setEpochKey,
        saveEpochKey,
        deleteEpochKey,
        setMembershipState,
        logger,
        generateEpochKey = defaultGenerateEpochKey,
        enqueueWrite = (fn) => fn(),
        snapshotRetries = DEFAULT_SNAPSHOT_RETRIES,
    } = deps

    const removedWriterKey = normalizeHex(writerKey, WRITER_KEY_BYTES)
    if (!removedWriterKey) {
        logger.log('[WARNING] removeMemberAndRotateEpoch rejected invalid writer key')
        return rejected('invalid-writer-key')
    }
    if (!autobase?.writable) {
        logger.log('[WARNING] removeMemberAndRotateEpoch rejected; autobase is not writable')
        return rejected('not-writable')
    }
    if (!canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) {
        logger.log('[WARNING] removeMemberAndRotateEpoch rejected; only the owner device can remove members')
        return rejected('not-owner')
    }
    if (!membershipState.writers?.has(removedWriterKey)) {
        logger.log('[WARNING] removeMemberAndRotateEpoch rejected; writer is not active')
        return rejected('unknown-writer')
    }

    const previousEpochKey = epochKey ? Buffer.from(epochKey) : null
    const previousMembershipState = cloneMembershipState(membershipState)
    const nextEpochKey = generateEpochKey()
    const previousEpoch = membershipState.currentEpoch || 1
    const nextEpoch = previousEpoch + 1

    // Build phase: construct the grants and the signed record from the current
    // membership state. Nothing durable or live-visible is changed yet, so a
    // failure here needs no rollback.
    let membershipRecord
    try {
        const recipients = [...membershipState.writers]
            .filter((activeWriterKey) => activeWriterKey !== removedWriterKey)
            .map((activeWriterKey) => ({
                writerKey: activeWriterKey,
                epochPublicKey: membershipState.writerEpochPublicKeys.get(activeWriterKey),
            }))

        if (recipients.some((recipient) => !recipient.epochPublicKey)) {
            throw new Error('Cannot re-key: one or more remaining writers lack epoch public keys')
        }

        const epochGrants = createEpochGrants({ epochKey: nextEpochKey, recipients })
        if (epochGrants.length !== recipients.length) {
            throw new Error('Cannot re-key: failed to create grants for every remaining writer')
        }

        membershipRecord = createRemoveWriterMembershipRecord({
            ownerAuthorityKeyPair,
            writerKey: removedWriterKey,
            baseKey: autobase.key,
            sequence: nextMembershipSequence(membershipState),
            previousEpoch,
            epoch: nextEpoch,
            epochKey: nextEpochKey,
            epochGrants,
        })
    } catch (e) {
        logger.log('[ERROR] removeMemberAndRotateEpoch could not prepare the re-key:', e)
        return { ok: false, committed: false, snapshot: false, reason: 'precommit-failed' }
    }

    // Commit phase: flip the epoch key and append the membership record + the
    // re-encrypted snapshot as a single serialized unit so no list write can
    // interleave between the epoch advance and the snapshot (which would tag an
    // op with a mismatched epoch). enqueueWrite is the same chain list mutations
    // use; the default passthrough keeps this testable in isolation.
    let committed = false
    let snapshotWritten = false
    let commitError = null

    await enqueueWrite(async () => {
        if (!(await saveEpochKey(nextEpochKey))) {
            commitError = new Error('Could not persist rotated epoch key')
            return
        }
        setEpochKey(nextEpochKey)

        try {
            await autobase.append(membershipRecord)
            await autobase.update()
        } catch (e) {
            commitError = e
            return
        }
        committed = true

        // Read the list fresh inside the serialized unit (after apply advanced
        // the epoch) so the snapshot reflects every write ordered before the
        // re-key — not a stale copy captured when the RPC arrived.
        snapshotWritten = await appendEpochSnapshot({
            autobase,
            prepareListAppendOperation,
            currentList: getCurrentList(),
            retries: snapshotRetries,
            logger,
        })
    })

    if (!committed) {
        // Pre-commit failure inside the unit: restore the prior epoch read-write
        // and never leave the base in the half-rotated state.
        logger.log('[ERROR] removeMemberAndRotateEpoch failed before commit:', commitError)
        setMembershipState(previousMembershipState)
        setEpochKey(previousEpochKey)
        if (previousEpochKey) await saveEpochKey(previousEpochKey)
        else await deleteEpochKey()
        logger.log('[INFO] Restored previous epoch after interrupted re-key')
        return { ok: false, committed: false, snapshot: false, reason: 'rolled-back' }
    }

    if (snapshotWritten) {
        logger.log('[AUDIT] Member removed and epoch rotated', {
            writerKey: removedWriterKey,
            epoch: nextEpoch,
            epochKeyHash: epochKeyHashHex(nextEpochKey),
        })
        return { ok: true, committed: true, snapshot: true, epoch: nextEpoch }
    }

    // The removal + epoch advance are committed and irreversible, so the
    // security goal is already met — only the snapshot (which re-hydrates
    // post-re-key joiners) failed. Report a degraded success, loudly.
    logger.log('[AUDIT] Member removed and epoch rotated, but re-encrypted snapshot did not persist', {
        writerKey: removedWriterKey,
        epoch: nextEpoch,
        epochKeyHash: epochKeyHashHex(nextEpochKey),
    })
    logger.log('[ERROR] Re-key snapshot incomplete; writers joining after this re-key may need a manual sync until a new snapshot lands')
    return { ok: true, committed: true, snapshot: false, reason: 'snapshot-incomplete', epoch: nextEpoch }
}

// Append the re-encrypted current list under the new epoch key, retrying a
// bounded number of times. Failures are swallowed and reported via the return
// value so a flaky snapshot append cannot trigger a rollback of the already
// committed removal.
async function appendEpochSnapshot({ autobase, prepareListAppendOperation, currentList, retries, logger }) {
    const totalAttempts = Math.max(1, Number(retries) + 1)
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        try {
            await autobase.append(prepareListAppendOperation(createListOperation('list', currentList)))
            await autobase.update()
            return true
        } catch (e) {
            logger.log(`[WARNING] Re-key snapshot append attempt ${attempt}/${totalAttempts} failed:`, e)
        }
    }
    return false
}

function rejected(reason) {
    return { ok: false, committed: false, snapshot: false, reason }
}

function normalizeHex(value, bytes) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const buffer = Buffer.from(value)
        return buffer.length === bytes ? buffer.toString('hex') : null
    }
    if (typeof value !== 'string') return null
    const hex = value.trim().toLowerCase()
    return HEX.test(hex) && hex.length === bytes * 2 ? hex : null
}
