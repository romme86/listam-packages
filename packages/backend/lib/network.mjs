import Hyperswarm from "hyperswarm"
import BlindPairing from "blind-pairing"
import z32 from "z32"
import { apply, open, primaryContext, resetApplyMembershipCheckpoint, resetSharedBasesOnBaseSwitch, storagePath, peerKeysString, keyFilePath, encKeyFilePath, ownerAuthorityKeyFilePath, legacyInviteFilePath, recoveryPolicy, swarmBootstrap } from "../backend.mjs"
import { saveAutobaseKey, saveEncryptionKey, saveOwnerAuthorityKey, deleteOwnerAuthorityKey, saveEpochKey, deleteEpochKey, saveEpochEncryptionKey, deleteEpochEncryptionKey, deleteLegacyInviteFile, deleteLegacyKeyFile } from "./key.mjs"
import { deleteBackendSecret, secretFingerprint } from "./secrets.mjs"
import { describeCorruption, isCorruptionSignature, planRecoveryAction, quarantineStorageRoot } from "./recovery.mjs"
import { INVITE_MAX_USES, isInviteUsable, reserveInviteUse, withInvitePolicy } from "./invite-policy.mjs"
import { createJoinRollbackSnapshot, restoreJoinRollbackSnapshot } from "./join-rollback.mjs"
import { createAutoBackup } from "./auto-backup.mjs"
import { performMemberRemovalRekey } from "./rekey.mjs"
import { epochResyncRecordMatchesMembership, performEpochResync } from './epoch-resync.mjs'
import { createEpochGrantChannel } from './epoch-grant-channel.mjs'
import { createJoinProgressDeadline } from './join-progress.mjs'
import { performCompaction } from './compaction-writer.mjs'
import { createCompactionState, seedCompactionBarrier } from './compaction.mjs'
import { compactionReadiness, reducePresence } from '@listam/domain/presence'
import { validateDirectEpochGrant } from './epoch-direct-adoption.mjs'
import {
    buildMembershipRoster,
    canCreateMembershipInvite,
    createAddWriterMembershipRecord,
    createMembershipState,
    createOwnerAuthorityKeyPair,
    createOwnerBootstrapRecord,
    nextMembershipSequence,
    ownerAuthorityPublicKeyHex,
    reduceMembershipLog,
    shouldAdoptBootMembership,
} from "./membership.mjs"
import { ownerRecoveryCodeFromKeyPair, recoverOwnerAuthorityFromCode } from "./owner-recovery.mjs"
import {
    createEpochEncryptionKeyPair,
    decodeInviteEpochData,
    encodeInviteEpochData,
    epochPublicKeyHex,
    generateEpochKey,
    reconcileLegacyEpochEncryptionKeyPair,
} from './key-epochs.mjs'
import { RPC_MESSAGE, RPC_GET_KEY, SYNC_LIST } from "@listam/protocol"
import Corestore from "corestore"
import Autobase from "autobase"
import b4a from "b4a"
import hypercoreCrypto from "hypercore-crypto"
import {
    autobase,
    rpc,
    addedStaticPeers,
    swarm,
    baseKey,
    store,
    discovery,
    peerCount,
    currentList,
    pairing,
    currentInvite,
    encryptionKey,
    ownerAuthorityKeyPair,
    epochKey,
    epochEncryptionKeyPair,
    membershipState,
    compactionState,
    pendingRecovery,
    setAutobase,
    setAddedStaticPeers,
    setSwarm,
    setDiscovery,
    setPeerCount,
    setStore,
    setBaseKey,
    setPairing,
    setPairingMember,
    setCurrentInvite,
    setCurrentList,
    setEncryptionKey,
    setOwnerAuthorityKeyPair,
    setEpochKey,
    setEpochEncryptionKeyPair,
    setMembershipState,
    setCompactionState,
    setPendingRecovery,
    isPendingJoinSuccess,
    setIsPendingJoinSuccess
} from "./state.mjs"
import { enqueueWrite, prepareListAppendOperation, rebuildListFromPersistedOps, rebuildExtraListItems, rebuildAllItems, projectItemsToFrontend, readPersistedMembershipRecords, resetViewCheckpoint, syncListToFrontend, waitForFlushableWriter , tryReplayOutbox} from "./item.mjs"
import { startPresenceHeartbeat, pokePresence, resetPresenceAccounting } from "./presence-heartbeat.mjs"
import { logger } from "./logger.mjs"
import { getBackendFs } from './platform-fs.mjs'
import { recoverEpochKeyFromMembership } from './epoch-recovery.mjs'

let _initPromise = null
let _writableCheckTimer = null
let inviteUsesRemaining = 0
let _joinedBase = false
// RPC_REQUEST_SYNC is also fired periodically by desktop. Re-grant once per
// owner backend/base membership+epoch generation; concurrent requests share the
// same promise. Reconnecting peers receive the cached signed grant directly over
// Noise, without appending another membership record or repair batch. A changed
// writer roster or epoch invalidates the cache and causes exactly one new batch.
let _epochResyncDone = false
let _epochResyncPromise = null
let _epochResyncRecord = null
const _epochGrantChannels = new Set()

// Network-status reporting (the header readiness dot). Each initAutobase pass
// builds a fresh swarm; _netStatusGen guards listeners so a torn-down base's
// dht events can never broadcast over the new base. _lastNetStatus dedupes so
// the frontend only sees real transitions.
let _netStatusGen = 0
let _lastNetStatus = null

// One local writer core per JOINED base. Reusing the pre-join 'local' core
// across a base switch leaks blocks written under the previous base's
// encryption into the joined base's writer log; the writer pipeline hits
// DECODING_ERROR on block 0, freezes silently, and from then on every
// autobase.append busy-loops at full CPU without ever resolving (the
// 2026-06-11 cross-device wedge). The scope name is derivable both from the
// invite before pairing and from the stored base key after a restart
// (discoveryKey is a hash of the base key), and corestore derives the same
// keypair for it on every open of the same storage root.
const LOCAL_WRITER_SCOPE_USERDATA = 'listam/local-writer-scope'

function joinedWriterScopeName(baseDiscoveryKey) {
    return `local-join-${b4a.toString(baseDiscoveryKey, 'hex')}`
}

// The key the host must authorize is the writer CORE key (manifest-derived),
// not the raw signing key; getLocalKey opens the core exactly the way
// autobase's boot will and reports the key it ends up with.
async function deriveJoinedWriter(baseDiscoveryKey) {
    const scopeName = joinedWriterScopeName(baseDiscoveryKey)
    const keyPair = await store.createKeyPair(scopeName)
    const writerKey = await Autobase.getLocalKey(store, { keyPair })
    return { scopeName, keyPair, writerKey }
}

// Read the scope recorded at join time from the well-known 'local' core and
// validate it against the base being opened — a scope minted for a different
// base (e.g. after a join rollback reopens the previous base) is ignored, so
// older bases keep their original 'local' writer untouched.
async function loadScopedWriterKeyPair(forBaseKey) {
    const lc = store.get({ name: 'local' })
    await lc.ready()
    let scopeRaw = null
    try {
        scopeRaw = await lc.getUserData(LOCAL_WRITER_SCOPE_USERDATA)
    } finally {
        await lc.close()
    }
    if (!scopeRaw) return null
    const expected = joinedWriterScopeName(hypercoreCrypto.discoveryKey(forBaseKey))
    if (b4a.toString(scopeRaw) !== expected) return null
    return store.createKeyPair(expected)
}

// Temp swarm/pairing kept alive until waitForWritable completes
let _tempSwarm = null
let _tempPairing = null

// Polls autobase.update() every second until the local node becomes writable,
// then broadcasts join-success. Falls back to join-error after 120 s.
// Also syncs replicated items on each attempt so the guest sees the host's
// list even before write access is confirmed.
function cleanupTempSwarm() {
    // Recorded because join failures are hard to reconstruct after the fact:
    // this teardown lands right where a guest's main-swarm connections start
    // dying at the idle timeout, and knowing what was destroyed and what the
    // main swarm held at the time is what separates the two cases.
    logger.log('[INFO] Temp swarm teardown', {
        tempConnections: _tempSwarm?.connections?.size ?? null,
        mainConnections: swarm?.connections?.size ?? null,
        autobasePresent: !!autobase,
    })
    if (_tempPairing) {
        try { _tempPairing.close() } catch (_) {}
        _tempPairing = null
    }
    if (_tempSwarm) {
        try { _tempSwarm.destroy() } catch (_) {}
        _tempSwarm = null
    }
}

// Join watch: wait for this guest to become writable, then for the main swarm
// to connect.
//
// This used to poll autobase.update() once a second for up to 120 seconds, and
// on EVERY tick rebuild the whole list from persisted ops and push it to the
// frontend — 120 full projections and 120 full re-renders for one join. Autobase
// emits 'update' when the linearized view advances and Hyperswarm emits
// 'connection'; those are the actual signals, so the watch is driven by them and
// keeps only a slow fallback poll in case one is missed.
//
// A generation token guards every callback. A second join (or a base switch)
// supersedes the first, and without it a late callback from the old attempt
// could report success for a base that is no longer current.
// How long the watch tolerates seeing NO forward progress before giving up.
//
// This is deliberately not a wall-clock cap on the whole join. A guest joining a
// base with a long history has to replay all of it through apply() before
// Autobase settles and `writable` flips, and that replay is unbounded in the
// size of the project: a phone joining a base that had rotated through seven
// epochs ground for ~5 minutes at full CPU, because every op predating the
// epoch it was granted fails to decrypt (one AEAD attempt per held key) before
// being skipped. A fixed 120s cap reported failure while the backend was still
// working, and the join then succeeded minutes later with the UI already showing
// an error — see the 2026-07-29 Nothing Phone join.
//
// So the deadline is refreshed by evidence of progress (the linearized view
// grew, or writability advanced a phase). It only fires when the guest is
// genuinely stalled: nothing linearizing and no writability for this long.
const JOIN_NO_PROGRESS_TIMEOUT_MS = 120_000
const JOIN_FALLBACK_POLL_MS = 5000
let _joinGeneration = 0
let _joinDetach = null

function endJoinWatch() {
    if (_joinDetach) {
        try { _joinDetach() } catch (_) {}
        _joinDetach = null
    }
    if (_writableCheckTimer) {
        clearTimeout(_writableCheckTimer)
        _writableCheckTimer = null
    }
}

function waitForWritable() {
    endJoinWatch()
    const gen = ++_joinGeneration
    const progress = createJoinProgressDeadline({ timeoutMs: JOIN_NO_PROGRESS_TIMEOUT_MS })
    // The view length is an exact, O(1) answer to "has anything new linearized?",
    // so the expensive rebuild+push only runs when there is genuinely more to
    // show — not on every wake-up.
    let pushedAtViewLength = -1
    let busy = false
    let phase = 'writable'

    const current = () => gen === _joinGeneration && isPendingJoinSuccess

    function finish(kind, message) {
        if (!current()) return
        endJoinWatch()
        setIsPendingJoinSuccess(false)
        broadcastMessage(kind === 'error' ? { type: 'join-error', message } : { type: 'join-success' })
        broadcastNetworkStatus()
        cleanupTempSwarm()
    }

    async function syncWhatHasArrived() {
        const viewLength = autobase?.view?.length ?? 0
        if (viewLength === pushedAtViewLength) return
        pushedAtViewLength = viewLength
        try {
            const list = await rebuildListFromPersistedOps()
            setCurrentList(list)
            if (list.length > 0) syncListToFrontend(list)
            projectItemsToFrontend(await rebuildExtraListItems())
        } catch (e) {
            logger.log('[WARNING] join watch: partial sync failed:', e?.message ?? e)
        }
    }

    async function evaluate() {
        if (!current() || busy) return
        busy = true
        try {
            try {
                if (autobase) await autobase.update()
            } catch (e) {
                logger.log('[ERROR] join watch: autobase.update failed:', e?.message ?? e)
            }
            if (!current()) return

            // Drop the temp swarm as soon as the main one is up, so the host does
            // not count this guest twice.
            if (_tempSwarm && swarm?.connections?.size > 0) {
                logger.log('[INFO] Main swarm connected, cleaning up temp swarm')
                cleanupTempSwarm()
            }

            // Replaying a long history is progress even though nothing is
            // writable yet: the view grows steadily while apply() works through
            // it. Refresh the deadline so the watch waits out a slow catch-up
            // and only gives up on a guest that has genuinely stopped moving.
            progress.observeViewLength(autobase?.view?.length ?? 0)

            await syncWhatHasArrived()
            if (!current()) return

            if (phase === 'writable' && autobase?.writable) {
                if (autobase.key) saveAutobaseKey(autobase.key)
                if (autobase.encryptionKey) {
                    setEncryptionKey(autobase.encryptionKey)
                    saveEncryptionKey(autobase.encryptionKey)
                }
                logger.log('[INFO] Guest became writable')

                // Rebroadcast the roster now that writable flipped true, so the
                // frontend can advertise a device name that was set (and refused)
                // while the base was still read-only. Cheap and idempotent.
                broadcastMembershipRoster()
                // Now that this guest can append, fire a presence beat so it shows
                // online to peers without waiting a full heartbeat cadence.
                pokePresence()

                if (swarm?.connections?.size > 0) {
                    finish('success')
                    return
                }
                phase = 'syncing'
                broadcastJoinPhase('syncing')
                progress.noteProgress()
                cleanupTempSwarm()
            }

            if (phase === 'syncing' && swarm?.connections?.size > 0) {
                logger.log('[INFO] Guest main swarm connected')
                finish('success')
                return
            }

            if (progress.expired()) {
                if (phase === 'syncing') {
                    // Writable but no peer yet: the join DID work, so report
                    // success rather than an error the user cannot act on.
                    logger.log('[INFO] Syncing phase timed out, but guest is writable — reporting success')
                    finish('success')
                } else {
                    // Pairing already succeeded, so the host DID hand over the
                    // credentials and its write grant is on the base. What
                    // stalled is this device applying it, so do not word this as
                    // the host withholding permission — that sends the user to
                    // audit a desktop that did nothing wrong.
                    const stalledAtZero = (autobase?.view?.length ?? 0) === 0
                    logger.log('[ERROR] Join stalled with no forward progress.', {
                        view: autobase?.view?.length ?? null,
                        mainSwarm: swarm?.connections?.size ?? null,
                        tempSwarm: _tempSwarm?.connections?.size ?? 0,
                    })
                    finish('error', stalledAtZero
                        ? 'Paired, but no project data has arrived yet. Check the connection and try again.'
                        : 'Paired, but syncing this project stalled before write access took effect. It may finish in the background — reopen the app shortly.')
                }
            }
        } finally {
            busy = false
        }
    }

    const onSignal = () => { void evaluate() }
    const base = autobase
    const mainSwarm = swarm
    try { base?.on('update', onSignal) } catch (_) {}
    try { mainSwarm?.on('connection', onSignal) } catch (_) {}

    function tick() {
        if (!current()) return
        void evaluate()
        if (current()) _writableCheckTimer = setTimeout(tick, JOIN_FALLBACK_POLL_MS)
    }
    _writableCheckTimer = setTimeout(tick, JOIN_FALLBACK_POLL_MS)

    _joinDetach = () => {
        try {
            if (typeof base?.off === 'function') base.off('update', onSignal)
            else base?.removeListener?.('update', onSignal)
        } catch (_) {}
        try {
            if (typeof mainSwarm?.off === 'function') mainSwarm.off('connection', onSignal)
            else mainSwarm?.removeListener?.('connection', onSignal)
        } catch (_) {}
    }

    // Evaluate once immediately: the guest may already be writable.
    void evaluate()
}

export function createInvite() {
    if (!autobase) return null
    if (!canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) {
        setCurrentInvite(null)
        inviteUsesRemaining = 0
        logger.log('[WARNING] Invite creation rejected; only the owner device can create or revoke invites')
        return null
    }

    // Return an existing invite only while it is unexpired, unused, AND minted
    // for the current epoch — its signed additional data carries the epoch key
    // the joiner bootstraps from, so a rotation must retire it.
    const currentEpoch = Number(membershipState?.currentEpoch) || 0
    if (isInviteUsable(currentInvite, inviteUsesRemaining) && currentInvite.epochAtMint === currentEpoch) {
        return z32.encode(currentInvite.invite)
    }

    // The epoch key rides in the invite's signed additional data because the
    // BlindPairing confirm payload cannot carry extra fields (see key-epochs).
    // The compaction barrier rides along for a different reason: the guest needs
    // it before it opens the base, or it replays the history the barrier exists
    // to let it skip.
    const epochData = encodeInviteEpochData(epochKey, currentEpoch, compactionState?.record ?? null)
    if (!epochData) {
        logger.log('[WARNING] Invite creation rejected; no current epoch key to embed')
        return null
    }
    const inv = withInvitePolicy(BlindPairing.createInvite(autobase.key, { data: epochData }))
    inv.epochAtMint = currentEpoch
    setCurrentInvite(inv)
    inviteUsesRemaining = INVITE_MAX_USES
    deleteLegacyInviteFile(legacyInviteFilePath)

    return z32.encode(inv.invite)
}

function rotateInviteAndNotifyFrontend() {
    setCurrentInvite(null)
    inviteUsesRemaining = 0
    deleteLegacyInviteFile(legacyInviteFilePath)

    const newZ32 = createInvite()
    sendInviteKeyToFrontend(newZ32 || '')
}

function sendInviteKeyToFrontend(inviteKey) {
    if (!rpc) return
    const req = rpc.request(RPC_GET_KEY)
    req.send(inviteKey)
}

export function setupBlindPairing() {
    if (!autobase || !swarm) return

    setPairing(new BlindPairing(swarm))

    setPairingMember(pairing.addMember({
        discoveryKey: autobase.discoveryKey,
        onadd: async (candidate) => {
            // Match invite
            if (!currentInvite || !b4a.equals(currentInvite.id, candidate.inviteId)) {
                try { candidate.close() } catch (_) {}
                return
            }

            const reservation = reserveInviteUse(currentInvite, inviteUsesRemaining)
            if (!reservation.ok) {
                try { candidate.close() } catch (_) {}
                rotateInviteAndNotifyFrontend()
                return
            }

            const reservedInvite = currentInvite
            inviteUsesRemaining = reservation.usesRemaining
            setCurrentInvite(null)

            try {
                // Open with invite's public key
                candidate.open(reservedInvite.publicKey)

                if (!autobase.writable) {
                    throw new Error('Host is not writable and cannot accept invite')
                }
                if (!canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) {
                    throw new Error('Only the owner device can accept invite candidates')
                }

                // Get joiner's writer key and epoch public key from userData.
                const joiner = parseJoinCandidateUserData(candidate.userData)
                if (!joiner?.writerKey) throw new Error('Join candidate did not provide a writer key')

                const membershipRecord = createAddWriterMembershipRecord({
                    ownerAuthorityKeyPair,
                    writerKey: joiner.writerKey,
                    baseKey: autobase.key,
                    sequence: nextMembershipSequence(membershipState),
                    epochPublicKey: joiner.epochPublicKey,
                })
                await autobase.append(membershipRecord)
                await autobase.update()

                // A rekey while this invite was outstanding would hand the
                // joiner a stale epoch key; refuse and rotate instead.
                if (reservedInvite.epochAtMint !== (Number(membershipState.currentEpoch) || 0)) {
                    throw new Error('Invite was minted for a rotated epoch; rotating invite')
                }

                // Send our base key + encryption key. The current epoch key
                // travels in the invite's signed additional data
                // (reservedInvite.additional) — confirm() cannot carry extra
                // fields.
                candidate.confirm({
                    key: autobase.key,
                    encryptionKey: autobase.encryptionKey,
                    additional: reservedInvite.additional,
                })
            } catch (e) {
                logger.log('[ERROR] Failed to accept invite candidate:', e)
                try { candidate.close() } catch (_) {}
            } finally {
                rotateInviteAndNotifyFrontend()
            }
        }
    }))
}

async function tearDownAutobaseSwarmStore() {
    // Stop any join watch AND detach its autobase/swarm listeners. Cancelling the
    // timer alone used to be enough when the watch was pure polling; now that it
    // is event-driven, a listener left on a torn-down base is both a leak and a
    // way for a superseded join to report success for the wrong base.
    endJoinWatch()
    setIsPendingJoinSuccess(false)
    for (const channel of _epochGrantChannels) channel.close()
    _epochGrantChannels.clear()

    // 1. Clean up BlindPairing
    if (pairing) {
        try {
            await pairing.close()
        } catch (e) {
            logger.log('[ERROR] Error closing blind pairing:', e)
        }
        setPairing(null)
        setPairingMember(null)
    }

    // 2. Clean up previous Autobase instance (if any)
    if (autobase) {
        try {
            autobase.removeAllListeners('append')
            if (typeof autobase.close === 'function') {
                logger.log('[INFO] Closing previous Autobase instance...')
                await autobase.close()
            } else {
                logger.log('[WARNING] Previous Autobase has no close() method, skipping close')
            }
        } catch (e) {
            logger.log('[ERROR] Error while closing previous Autobase:', e)
        }
        setAutobase(null)
    }

    // 3. Tear down networking bound to old store
    if (discovery) {
        try {
            await discovery.destroy()
        } catch (e) {
            logger.log('[ERROR] Error destroying discovery:', e)
        }
        setDiscovery(null)
    }

    if (swarm) {
        try {
            await swarm.destroy()
        } catch (e) {
            logger.log('[ERROR] Error destroying swarm:', e)
        }
        setSwarm(null)
        // Invalidate stale dht listeners and report "connecting" (no swarm).
        _netStatusGen++
        broadcastNetworkStatus()
    }

    // 4. Close old store
    if (store) {
        try {
            await store.close()
        } catch (e) {
            logger.log('[ERROR] Error closing Corestore:', e)
        }
    }
}

// Install the membership state the boot tail reduced from the view, unless
// apply() has already established a newer one (see shouldAdoptBootMembership).
function adoptBootMembershipState(state) {
    if (!shouldAdoptBootMembership(membershipState, state)) {
        logger.log('[INFO] Boot membership snapshot is behind live apply state; keeping the live one', {
            liveSequence: Number(membershipState?.highestSequence) || 0,
            bootSequence: Number(state?.highestSequence) || 0,
        })
        return
    }
    setMembershipState(state)
}

async function ensureOwnerMembership({ allowOwnerMigration }) {
    if (membershipState.ownerAuthorityKey) {
        if (allowOwnerMigration && ownerAuthorityKeyPair) {
            await ensureLocalEpochSecrets()
        }
        return
    }

    if (!allowOwnerMigration) {
        logger.log('[INFO] Owner membership migration skipped for joined base')
        return
    }
    // A base reached through an invite has an owner by construction, even when
    // this device has not replayed far enough to have seen the record yet.
    // allowOwnerMigration only covers the join itself; a later RESTART of that
    // same base re-enters here with the default (true), so without this the
    // "no owner visible yet" window on every relaunch is enough to append a
    // bootstrap record that can only ever be rejected.
    if (_joinedBase) {
        logger.log('[INFO] Owner membership migration skipped; this base was joined, not created here')
        return
    }
    if (!autobase?.writable || !autobase?.local?.key || !autobase?.key) {
        logger.log('[WARNING] Owner membership migration skipped; local base is not writable')
        return
    }

    let keyPair = ownerAuthorityKeyPair
    if (!keyPair) {
        keyPair = createOwnerAuthorityKeyPair()
        setOwnerAuthorityKeyPair(keyPair)
        await saveOwnerAuthorityKey(keyPair.secretKey)
    }

    const { localEpochEncryptionKeyPair, localEpochKey } = await ensureLocalEpochSecrets()

    const record = createOwnerBootstrapRecord({
        ownerAuthorityKeyPair: keyPair,
        writerKey: autobase.local.key,
        baseKey: autobase.key,
        epochPublicKey: epochPublicKeyHex(localEpochEncryptionKeyPair),
        epochKey: localEpochKey,
        epoch: 1,
    })
    await autobase.append(record)
    await autobase.update()

    logger.log('[INFO] Bootstrapped owner-signed membership record', {
        ownerAuthorityKey: ownerAuthorityPublicKeyHex(keyPair),
    })
}

async function ensureLocalEpochSecrets() {
    let localEpochEncryptionKeyPair = epochEncryptionKeyPair
    if (!localEpochEncryptionKeyPair) {
        localEpochEncryptionKeyPair = createEpochEncryptionKeyPair()
        setEpochEncryptionKeyPair(localEpochEncryptionKeyPair)
        await saveEpochEncryptionKey(localEpochEncryptionKeyPair.secretKey)
    }

    let localEpochKey = epochKey
    if (!localEpochKey) {
        localEpochKey = generateEpochKey()
        setEpochKey(localEpochKey)
        await saveEpochKey(localEpochKey)
    }

    return { localEpochEncryptionKeyPair, localEpochKey }
}

export async function initAutobase(newBaseKey, options = {}) {
    if (_initPromise) {
        logger.log('[WARNING] initAutobase already running — returning existing init promise')
        return _initPromise
    }

    const allowOwnerMigration = options.allowOwnerMigration !== false

    _initPromise = (async () => {

        // Replacing a live personal base (e.g. a destructive whole-project join)
        // abandons the current project; close its shared single-list bases first.
        // On first boot there is no current base, so this is a no-op.
        if (autobase) {
            try { await resetSharedBasesOnBaseSwitch() } catch (e) { logger.log('[ERROR] reset shared bases on base switch:', e) }
        }

        await tearDownAutobaseSwarmStore()
        _joinedBase = false
        _epochResyncDone = false
        _epochResyncPromise = null
        _epochResyncRecord = null
        setMembershipState(createMembershipState())
        setCurrentInvite(null)
        inviteUsesRemaining = 0
        // The checkpoints are keyed to one base's linearized view; a teardown
        // or base switch invalidates them.
        resetViewCheckpoint()
        resetApplyMembershipCheckpoint()
        // Drop presence accounting too: the next base re-seeds its own totals and
        // starts a fresh session (see startPresenceHeartbeat in the boot tail).
        resetPresenceAccounting()

        const baseStoragePath = `${storagePath}-local`

        setStore(new Corestore(baseStoragePath))
        await store.ready()
        setBaseKey(newBaseKey || null)
        logger.log(
            '[INFO] Initializing a new autobase with key:',
            baseKey ? baseKey.toString('hex') : '(new base)'
        )

        // Clear stale user data from the local core ONLY when the base key
        // is changing (e.g. guest joining a host's base).  boot.js reads
        // 'autobase/encryption' from the local core and uses it over the
        // key passed via opts.  Without clearing on base-key change, a
        // guest that previously ran its own fresh base would keep the OLD
        // encryption key instead of the one received via blind pairing.
        // On a normal restart (same base key), we must NOT clear — doing
        // so would wipe the boot record and break persistence.
        let scopedWriterKeyPair = null
        if (baseKey) {
            const lc = store.get({ name: 'local' })
            await lc.ready()
            const existingRef = await lc.getUserData('referrer')
            if (!existingRef || !b4a.equals(existingRef, baseKey)) {
                await lc.setUserData('autobase/encryption', null)
                await lc.setUserData('autobase/boot', null)
                await lc.setUserData('referrer', null)
                logger.log('[INFO] Cleared stale local-core user data (base key changed)')
            }
            await lc.close()
            scopedWriterKeyPair = await loadScopedWriterKeyPair(baseKey)
            if (scopedWriterKeyPair) logger.log('[INFO] Using joined-base scoped local writer')
        }
        _joinedBase = Boolean(scopedWriterKeyPair)

        const autobaseOpts = {
            // The personal base reduces through the shared apply(), bound to the
            // primaryContext adapter (state.mjs globals). Shared single-list bases
            // bind apply() to their own BaseContext instead.
            apply: (nodes, view, host) => apply(primaryContext, nodes, view, host),
            open,
            valueEncoding: 'json',
            encrypt: true,
            encryptionKey: encryptionKey || undefined,
            ...(scopedWriterKeyPair ? { keyPair: scopedWriterKeyPair } : {})
        }
        setAutobase(new Autobase(store, baseKey, autobaseOpts))
        logger.log('[INFO] Calling autobase.ready()... encKey:', encryptionKey ? 'present' : 'none')
        try {
            await autobase.ready()
        } catch (e) {
            if (isCorruptionSignature(e)) {
                // M4: never wipe on corruption. Keep the data and key material
                // untouched, release the storage root, and wait for an
                // owner-directed recovery action (performStorageRecovery).
                await enterPendingRecovery(e, baseStoragePath)
                return
            }
            throw e
        }
        setPendingRecovery(null)
        logger.log(
            '[INFO] autobase.ready() resolved. writable?',
            autobase.writable,
            '| key:',
            autobase.key?.toString('hex'),
            '| encKey:',
            autobase.encryptionKey ? autobase.encryptionKey.toString('hex').slice(0, 16) + '...' : 'none',
        )

        // Save the autobase key for persistence across restarts
        if (autobase.key && autobase.writable) {
            saveAutobaseKey(autobase.key)
        }

        // Save encryption key after autobase is ready
        if (autobase.encryptionKey && autobase.writable) {
            setEncryptionKey(autobase.encryptionKey)
            saveEncryptionKey(autobase.encryptionKey)
        }

        autobase.on('append', async () => {
            logger.log('[INFO] New data appended, updating view...')
        })

        // Load existing items from view and sync to frontend.
        // BOUNDED: on a freshly joined base the linearizer may need blocks only
        // peers can provide, but the swarm joins later in init — an unbounded
        // update() then dangles with no live handles left and Node exits 0
        // silently (observed 2026-07-02: joined headless boot-looped under
        // systemd). The un-unref'd timer doubles as the keep-alive; boot
        // continues and the view completes once the swarm connects.
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                logger.log('[WARNING] autobase.update() did not settle within 15s at boot; continuing (view completes after peers connect)')
                resolve()
            }, 15_000)
            autobase.update().then(
                () => { clearTimeout(timer); resolve() },
                (err) => { clearTimeout(timer); logger.log('[ERROR] autobase.update() failed at boot:', err); resolve() }
            )
        })
        // Rebuild membership state from the records apply() persisted into the
        // view. Autobase does not re-run apply over history on restart, so
        // without this the owner key, writer set, and sequence high-water mark
        // would be empty here — re-bootstrapping the owner on every launch and
        // reusing sequence numbers. Seeding from the durable log makes the
        // bootstrap below run exactly once and keeps sequences monotonic.
        //
        // BOUNDED like update() above: these view reads core.get() with
        // wait:true, so on a freshly joined base a block only peers hold makes
        // them dangle before the swarm exists — and with no handles left Node
        // exits 0 silently. Race the tail against a keep-alive; on timeout,
        // init proceeds to the swarm setup and the tail self-completes in the
        // background once peers supply the missing blocks (its awaits resume,
        // membership and list state land, and the frontend gets synced late).
        const bootViewTail = (async () => {
            const persistedMembership = await readPersistedMembershipRecords()
            const replayedMembership = reduceMembershipLog(persistedMembership, { baseKey: autobase.key })
            const localWriterKey = autobase.local?.key?.toString('hex') || null
            const expectedEpochPublicKey = localWriterKey
                ? replayedMembership.writerEpochPublicKeys.get(localWriterKey)
                : null
            let activeEpochEncryptionKeyPair = epochEncryptionKeyPair
            if (activeEpochEncryptionKeyPair && expectedEpochPublicKey) {
                const identity = reconcileLegacyEpochEncryptionKeyPair(
                    activeEpochEncryptionKeyPair,
                    expectedEpochPublicKey,
                )
                if (identity.migrated) {
                    activeEpochEncryptionKeyPair = identity.keyPair
                    setEpochEncryptionKeyPair(identity.keyPair)
                    await saveEpochEncryptionKey(identity.keyPair.secretKey)
                    logger.log('[AUDIT] Migrated legacy epoch encryption identity to membership-authorized key')
                } else if (!identity.matched) {
                    logger.log('[WARNING] Local epoch encryption identity does not match owner-signed membership', {
                        reason: identity.reason,
                    })
                }
            }
            const epochRecovery = recoverEpochKeyFromMembership(persistedMembership, {
                baseKey: autobase.key,
                localWriterKey,
                epochEncryptionKeyPair: activeEpochEncryptionKeyPair,
                currentEpochKey: epochKey,
            })
            adoptBootMembershipState(epochRecovery.state)
            if (epochRecovery.recovered) {
                setEpochKey(epochRecovery.epochKey)
                await saveEpochKey(epochRecovery.epochKey)
                logger.log('[INFO] Recovered current epoch key from persisted membership grant', {
                    epoch: epochRecovery.state.currentEpoch,
                })
            }
            await ensureOwnerMembership({ allowOwnerMigration })
            const rebuiltList = await rebuildListFromPersistedOps()
            setCurrentList(rebuiltList)
            syncListToFrontend(rebuiltList)
            projectItemsToFrontend(await rebuildExtraListItems())
            broadcastMembershipRoster()
            broadcastBaseState()
            // Base is up: (re-)arm the presence heartbeat, seeding this device's
            // cumulative online time from its own last presence item. Idempotent;
            // self-gates on writable+online, so a not-yet-writable guest simply
            // beats once pokePresence() fires on the writable transition above.
            await startPresenceHeartbeat()
        })()
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                logger.log('[WARNING] boot view reads did not settle within 15s; continuing init (they complete once peers connect)')
                resolve()
            }, 15_000)
            bootViewTail.then(
                () => { clearTimeout(timer); resolve() },
                (err) => { clearTimeout(timer); logger.log('[ERROR] boot view rebuild failed:', err); resolve() }
            )
        })

        // Add static peers only once
        if (!addedStaticPeers && peerKeysString) {
            const peerKeys = peerKeysString.split(',').filter(k => k.trim())
            for (const keyHex of peerKeys) {
                try {
                    const peerKey = Buffer.from(keyHex.trim(), 'hex')
                    const peerCore = store.get({ key: peerKey })
                    await peerCore.ready()
                    await autobase.addInput(peerCore)
                    logger.log('[INFO] Added peer writer from argv[1]')
                } catch (err) {
                    logger.log('[ERROR] Failed to add peer from argv[1]:', err.message)
                }
            }
            setAddedStaticPeers(true)
        }

        // Reset peer count on new base
        setPeerCount(0)
        broadcastPeerCount()

        // New replication swarm coming up — invalidate any previous base's
        // network-status listeners and report "connecting" until the DHT
        // bootstraps or a peer connects.
        const netGen = ++_netStatusGen
        _lastNetStatus = null

        // Use discoveryKey as swarm topic (NOT autobase.key)
        const topic = autobase.discoveryKey
        logger.log('[INFO] Discovery topic (replication swarm) ready')

        // Switch discovery to new topic
        if (discovery) {
            try {
                await discovery.destroy()
            } catch (e) {
                logger.log('[ERROR] Error destroying previous discovery:', e)
            }
        }

        setSwarm(new Hyperswarm(swarmOptions()))
        broadcastNetworkStatus()
        swarm.on('error', (err) => {
            logger.log('[ERROR] Replication swarm error:', err)
        })
        swarm.on('connection', (conn) => {
          // An exception escaping into hyperswarm's emitter would leave the
          // connection attached to nothing, with no trace anywhere — the exact
          // symptom this handler was investigated for. Log it instead.
          try {
            logger.log('[INFO] New peer connected (replication swarm)', b4a.from(conn.publicKey).toString('hex'))
            let grantChannel = null
            grantChannel = createEpochGrantChannel(conn, {
                onGrant: acceptDirectEpochGrant,
                logger,
                onClose: () => _epochGrantChannels.delete(grantChannel),
            })
            if (grantChannel) _epochGrantChannels.add(grantChannel)
            conn.on('error', (err) => {
                logger.log('[ERROR] Replication connection error:', err)
            })
            setPeerCount(swarm.connections.size)
            broadcastPeerCount()
            broadcastNetworkStatus()
            // A peer is reachable again, which is precisely the condition a
            // stalled writer was waiting for. Drain anything the outbox kept.
            tryReplayOutbox()
            // ...and the condition a presence beat was waiting for. Beats are
            // only written while something is connected (see hasAudience in
            // presence-heartbeat.mjs), so this is what makes this device visible
            // to the peer that just arrived, instead of up to a cadence later.
            // Self-gating and coalescing, so a burst of connections is one write.
            pokePresence()
            conn.on('close', () => {
                if (grantChannel) {
                    _epochGrantChannels.delete(grantChannel)
                    grantChannel.close()
                }
                setPeerCount(swarm.connections.size)
                broadcastPeerCount()
                broadcastNetworkStatus()
            })
            if (autobase) {
                const connectedBase = autobase
                const startReplication = () => {
                    // One line per connection, and it earns its keep: a join that
                    // never replicates looks identical from the outside whether
                    // replicate() was skipped, aimed at a superseded base, threw,
                    // or worked perfectly and the transport carried nothing. On
                    // 2026-07-28 this is what proved the last of those.
                    const skipped = conn.destroyed
                        ? 'conn-destroyed'
                        : connectedBase.closing ? 'base-closing' : null
                    logger.log('[INFO] Replication attach', {
                        skipped,
                        sameBaseAsCurrent: connectedBase === autobase,
                        baseKey: connectedBase.key ? b4a.toString(connectedBase.key, 'hex').slice(0, 8) : null,
                        writable: !!connectedBase.writable,
                        viewLength: connectedBase.view?.length ?? null,
                    })
                    if (skipped) return
                    try {
                        connectedBase.replicate(conn)
                        logger.log('[INFO] Replication attached')
                    } catch (e) {
                        logger.log('[ERROR] Replication attach threw:', e?.message ?? e)
                    }
                }
                if (epochResyncRecordMatchesMembership(_epochResyncRecord, membershipState)) {
                    // A peer may have upgraded since its previous connection and
                    // can now accept the same owner-signed record it previously
                    // rejected. Direct delivery is sufficient; do not append a
                    // fresh record and another full repair batch on every socket.
                    // Deliver BEFORE starting Autobase replication so a stale
                    // peer has the key before it sees already-appended repairs.
                    // NOTE: this branch DEFERS replication until an async grant
                    // publish settles — a promise that never settles would leave
                    // the connection idling with no data. Ruled out as the cause
                    // of the 2026-07-28 CI join failures, but keep it in mind.
                    publishEpochGrantToChannel(grantChannel, _epochResyncRecord).catch((err) => {
                        logger.log('[ERROR] Connected-peer direct epoch grant failed:', err)
                    }).finally(startReplication)
                } else {
                    // A connection is a replication signal, not permission to
                    // mutate durable state. The resync cache is intentionally
                    // process-local, so launching a full grant + repair batch
                    // here repeated it after every restart. If that append
                    // stalled, it occupied the shared write chain before the
                    // first user edit and reproduced the permanent read-only
                    // UI on every launch. Replicate now; epoch rotation and
                    // explicit recovery flows own durable repair writes.
                    startReplication()
                    _epochResyncDone = false
                    _epochResyncRecord = null
                }
            } else {
                logger.log('[WARNING] No Autobase yet to replicate with')
            }
          } catch (e) {
            // Whatever this is, it left the connection without replication.
            logger.log('[ERROR] Connection handler threw before replicating:', e?.stack ?? e?.message ?? e)
          }
        })
        // Track DHT reachability transitions for the header dot.
        wireNetworkStatusSignals(netGen)
        setDiscovery(swarm.join(topic, { server: true, client: true }))
        await discovery.flushed()
        logger.log('[INFO] Joined replication swarm for current base')
        broadcastNetworkStatus()

        // Set up blind pairing for accepting joiners
        setupBlindPairing()

        // Create invite and send to frontend
        const z32Invite = createInvite()
        sendInviteKeyToFrontend(z32Invite || '')

        // Tell clients whether this base was joined as a guest (the scoped
        // writer exists only for joined bases): a restarted guest must keep
        // reporting joined without ever seeing a live join-success event.
        broadcastBaseState()
    })()

    try {
        return await _initPromise
    } finally {
        _initPromise = null
    }
}

export function broadcastBaseState() {
    broadcastMessage({
        type: 'base-state',
        joined: _joinedBase,
        baseId: autobase?.key ? secretFingerprint(autobase.key.toString('hex')) : null,
        epoch: Number(membershipState?.currentEpoch) || 0,
    })
}

// Park the backend in a non-destructive degraded state after a corrupt
// ready(): close the handles that point at the suspect root, record what
// happened, and tell the frontend a recovery decision is needed. Data, key
// material, and the storage root itself are left exactly as they were.
async function enterPendingRecovery(error, baseStoragePath) {
    const description = describeCorruption(error)
    logger.log('[ERROR] Autobase storage appears corrupted; awaiting owner-directed recovery (nothing was deleted).', {
        signature: description.signature,
    })

    setAutobase(null)
    if (store) {
        try {
            await store.close()
        } catch (e) {
            logger.log('[ERROR] Error closing store of corrupt base:', e)
        }
        setStore(null)
    }

    setPendingRecovery({
        ...description,
        baseStoragePath,
        detectedAt: new Date().toISOString(),
    })
    broadcastMessage({
        type: 'recovery-required',
        reason: description.reason,
        policy: recoveryPolicy,
    })
}

// Owner-directed recovery (RPC_RECOVER_STORAGE). 'retry' reopens the same
// storage root (transient failures). 'reset' is the only destructive path:
// it requires an interactive policy plus pending corruption, quarantines the
// suspect root intact as a backup, and only then clears the key slots and
// starts a fresh base. Headless ('refuse-destructive') nodes can only retry.
export async function performStorageRecovery(action) {
    const plan = planRecoveryAction({ action, policy: recoveryPolicy, pending: pendingRecovery })
    if (!plan.ok) {
        logger.log('[WARNING] Storage recovery action rejected', { action, reason: plan.reason })
        broadcastMessage({ type: 'recovery-failed', reason: plan.reason })
        return { ok: false, reason: plan.reason }
    }

    if (action === 'retry') {
        logger.log('[AUDIT] Storage recovery: retrying with existing storage root')
        setPendingRecovery(null)
        await initAutobase(baseKey)
        if (pendingRecovery) return { ok: false, reason: 'still-corrupt' }
        broadcastMessage({ type: 'recovery-complete', mode: 'retry' })
        return { ok: true, mode: 'retry' }
    }

    const targetPath = pendingRecovery.baseStoragePath || `${storagePath}-local`
    const quarantined = quarantineStorageRoot(getBackendFs(), targetPath, {
        reason: pendingRecovery.reason,
        fingerprints: {
            baseKey: baseKey ? secretFingerprint(baseKey.toString('hex')) : null,
            encryptionKey: encryptionKey ? secretFingerprint(encryptionKey.toString('hex')) : null,
        },
    })
    if (!quarantined.ok && quarantined.reason !== 'missing') {
        logger.log('[ERROR] Storage recovery: quarantine failed; aborting reset so no data is lost', { reason: quarantined.reason })
        broadcastMessage({ type: 'recovery-failed', reason: 'quarantine-failed' })
        return { ok: false, reason: 'quarantine-failed' }
    }
    logger.log('[AUDIT] Storage recovery: corrupt root quarantined; starting owner-approved fresh base', {
        quarantined: quarantined.ok,
    })

    deleteBackendSecret('autobaseKey')
    deleteBackendSecret('encryptionKey')
    deleteBackendSecret('ownerAuthorityKey')
    deleteBackendSecret('epochKey')
    deleteBackendSecret('epochEncryptionKey')
    deleteLegacyKeyFile(keyFilePath)
    deleteLegacyKeyFile(encKeyFilePath)
    deleteLegacyKeyFile(ownerAuthorityKeyFilePath)
    setBaseKey(null)
    setEncryptionKey(null)
    setOwnerAuthorityKeyPair(null)
    setEpochKey(null)
    setEpochEncryptionKeyPair(null)

    setPendingRecovery(null)
    await initAutobase(null)
    if (pendingRecovery) return { ok: false, reason: 'still-corrupt' }
    broadcastMessage({ type: 'recovery-complete', mode: 'fresh-base' })
    return { ok: true, mode: 'fresh-base' }
}

let _joinPromise = null

export async function joinViaInvite(z32InviteStr) {
    if (_joinPromise) {
        logger.log('[WARNING] joinViaInvite already running — returning existing join promise')
        return _joinPromise
    }

    _joinPromise = (async () => {
        const rollbackSnapshot = createJoinRollbackSnapshot({
            currentList,
            baseKey,
            encryptionKey,
            ownerAuthorityKeyPair,
            epochKey,
            epochEncryptionKeyPair,
        })
        const normalizedInvite = normalizeInviteCode(z32InviteStr)
        const joinEpochEncryptionKeyPair = createEpochEncryptionKeyPair()

        // Clean up any leftover temp resources from a previous attempt
        cleanupTempSwarm()

        try {
            if (!normalizedInvite) {
                throw new Error('Invite is empty or invalid')
            }

            // Notify frontend: phase 1 — pairing
            broadcastJoinPhase('pairing')

            // 1. Derive a writer key SCOPED TO THE BASE WE ARE JOINING (see
            //    LOCAL_WRITER_SCOPE_USERDATA above) from the invite's discovery
            //    key. The keypair is deterministic for this storage root, so
            //    the same key is rebuilt after the post-pairing initAutobase
            //    and after every restart — the host authorizes the right core.
            if (!store) {
                throw new Error('corestore unavailable — cannot derive writer key')
            }
            const inviteInfo = BlindPairing.decodeInvite(z32.decode(normalizedInvite))
            if (!inviteInfo?.discoveryKey) {
                throw new Error('Invite does not carry a base discovery key')
            }
            const joinedWriter = await deriveJoinedWriter(inviteInfo.discoveryKey)
            const localWriterKey = joinedWriter.writerKey
            logger.log('[INFO] Guest localWriterKey ready (joined-base scope)')

            // 2. Temp swarm for blind pairing only.
            //    DO NOT close the candidate in onadd — closing it kills the
            //    underlying Noise connection, which is the only live link to the
            //    host. The temp swarm stays alive so we can replicate over it.
            _tempSwarm = new Hyperswarm(swarmOptions())
            _tempPairing = new BlindPairing(_tempSwarm)

            const result = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Pairing timed out'))
                }, 120000)

                _tempPairing.addCandidate({
                    invite: z32.decode(normalizedInvite),
                    userData: Buffer.from(JSON.stringify({
                        version: 1,
                        writerKey: localWriterKey.toString('hex'),
                        epochPublicKey: epochPublicKeyHex(joinEpochEncryptionKeyPair),
                    })),
                    onadd: async (paired) => {
                        clearTimeout(timeout)
                        resolve(paired)
                        // NOTE: do NOT call candidate.close() here — it kills
                        // the connection we need for replication bootstrapping.
                    }
                })
            })

            if (!result?.key || !result?.encryptionKey) {
                throw new Error('Pairing returned incomplete credentials')
            }
            // The epoch key arrives as the invite's signed additional data
            // (verified against the invite key pair by blind-pairing-core).
            const inviteEpoch = decodeInviteEpochData(result.data)
            if (!inviteEpoch) {
                throw new Error('Pairing returned no epoch key')
            }

            // Notify frontend: phase 2 — permission (waiting for write access)
            broadcastJoinPhase('permission')

            logger.log('[INFO] Blind pairing succeeded')
            logger.log('[INFO] Temp swarm connections after pairing:', _tempSwarm.connections.size)

            // Record the writer scope on the well-known 'local' core BEFORE
            // re-initializing, so initAutobase (now and on every restart of
            // this joined base) derives the same scoped writer keypair. A
            // later rollback to the previous base ignores it because the
            // scope name embeds this base's discovery key.
            {
                const lc = store.get({ name: 'local' })
                await lc.ready()
                await lc.setUserData(LOCAL_WRITER_SCOPE_USERDATA, b4a.from(joinedWriter.scopeName))
                await lc.close()
            }

            // Durable pre-join backup of the CURRENT lists, taken while the old
            // base is still intact (just before initAutobase replaces it).
            // Best-effort and no-throw: it must never abort the join. Skips
            // silently if the user hasn't set a backup password yet (the join is
            // gated on that in the UI, so normally one exists here).
            await createAutoBackup({ reason: 'pre-join' })

            // 3. Use initAutobase to set up the joined base — same proven code
            //    path the host uses. Set encryption key first so initAutobase
            //    picks it up.
            setOwnerAuthorityKeyPair(null)
            await deleteOwnerAuthorityKey()
            setEpochEncryptionKeyPair(joinEpochEncryptionKeyPair)
            await saveEpochEncryptionKey(joinEpochEncryptionKeyPair.secretKey)
            setEpochKey(inviteEpoch.epochKey)
            await saveEpochKey(inviteEpoch.epochKey)
            setEncryptionKey(result.encryptionKey)
            // Adopt the host's compaction barrier BEFORE the base opens, so the
            // first apply() batch already skips the superseded history instead
            // of grinding through ops it holds no key for. An older host sends
            // none, and the guest just replays as it always did.
            const seededBarrier = inviteEpoch.barrier ? seedCompactionBarrier(inviteEpoch.barrier) : null
            if (seededBarrier) {
                setCompactionState(seededBarrier)
                logger.log('[INFO] Adopted the host history-compaction barrier from the invite', {
                    sequence: seededBarrier.sequence,
                    epoch: seededBarrier.epoch,
                })
            } else {
                setCompactionState(createCompactionState())
            }
            await initAutobase(result.key, { allowOwnerMigration: false })

            // Commit the joined credentials NOW: the epoch keys are already
            // saved above and the runtime is on the joined base, so deferring
            // these to the writability paths loses them whenever the host
            // authorized our writer during pairing (the "already writable"
            // shortcut) — a restart then silently booted the previous base
            // with mixed epoch state. A later rollback re-saves the previous
            // credentials through its own initAutobase, so this stays
            // consistent on failure too.
            await saveAutobaseKey(result.key)
            await saveEncryptionKey(result.encryptionKey)

            logger.log('[INFO] Guest initAutobase complete. writable:', autobase?.writable, '| swarm connections:', swarm?.connections?.size)

            // 4. Replicate over the temp swarm's existing connections.
            //    The temp swarm has a live connection to the host from blind
            //    pairing. The main swarm needs DHT to find the host (can take
            //    30-60s or fail entirely on restricted networks). By replicating
            //    over the temp connection, we get immediate data exchange.
            if (_tempSwarm) {
                let tempConnCount = 0
                for (const conn of _tempSwarm.connections) {
                    if (conn.destroyed || conn.closed) continue
                    tempConnCount++
                    logger.log('[INFO] Guest: replicating autobase over temp swarm connection (alive:', !conn.destroyed, ')')
                    try {
                        autobase.replicate(conn)
                    } catch (e) {
                        logger.log('[ERROR] Failed to replicate over temp connection:', e)
                    }
                }
                logger.log('[INFO] Guest: replicated over', tempConnCount, 'temp connections')
            }

            // 5. Check writability
            if (autobase.writable) {
                logger.log('[INFO] Guest is already writable')
                broadcastMessage({ type: 'join-success' })
                cleanupTempSwarm()
            } else {
                logger.log('[INFO] Guest not yet writable — starting waitForWritable polling')
                setIsPendingJoinSuccess(true)
                waitForWritable()
            }
        } catch (e) {
            logger.log('[ERROR] joinViaInvite failed:', e)
            setIsPendingJoinSuccess(false)
            broadcastMessage({
                type: 'join-error',
                message: e?.message || 'Failed to join peer'
            })
            try {
                await restoreJoinRollbackSnapshot(rollbackSnapshot, {
                    rpc,
                    syncListCommand: SYNC_LIST,
                    setEncryptionKey,
                    setOwnerAuthorityKeyPair,
                    saveOwnerAuthorityKey,
                    deleteOwnerAuthorityKey,
                    setEpochKey,
                    saveEpochKey,
                    deleteEpochKey,
                    setEpochEncryptionKeyPair,
                    saveEpochEncryptionKey,
                    deleteEpochEncryptionKey,
                    initAutobase,
                })
            } catch (rollbackError) {
                logger.log('[ERROR] Failed to rollback previous session:', rollbackError)
            }
        } finally {
            if (!isPendingJoinSuccess) {
                cleanupTempSwarm()
            }
        }
    })()

    try { return await _joinPromise }
    finally { _joinPromise = null }
}

export async function removeMemberAndRotateEpoch(writerKey) {
    // The orchestration (validation, grant construction, epoch rotation,
    // rollback, and post-commit snapshot retry) lives in rekey.mjs so it can be
    // unit-tested without the BareKit-bound backend graph. Pass the current
    // state values and persistence setters; rekey.mjs snapshots them for
    // rollback. prepareListAppendOperation reads live state itself, so the
    // snapshot is encrypted under the rotated epoch once apply() has advanced it.
    const result = await performMemberRemovalRekey(writerKey, {
        autobase,
        epochKey,
        membershipState,
        ownerAuthorityKeyPair,
        // Pass a getter, not the array: the live `currentList` binding is read
        // fresh inside the serialized write unit so the snapshot is current.
        getCurrentList: () => currentList,
        prepareListAppendOperation,
        enqueueWrite,
        setEpochKey,
        saveEpochKey,
        deleteEpochKey,
        setMembershipState,
        logger,
    })
    if (result.committed) {
        _epochResyncDone = false
        _epochResyncRecord = null
        broadcastMembershipRoster()
        // The epoch rotated: any outstanding invite embeds the retired epoch
        // key in its signed additional data, so mint a fresh one.
        rotateInviteAndNotifyFrontend()
        // A rotation is exactly the moment history gets expensive for future
        // joiners: everything before it is now encrypted under a key an invite
        // will not carry. Flatten it if the mesh is ready — best-effort, and
        // never allowed to affect the removal's own success.
        try {
            await compactHistory({ trigger: 'rekey' })
        } catch (e) {
            logger.log('[WARNING] Post-rekey compaction failed; the removal stands', e)
        }
    }
    broadcastMessage(result.ok
        ? { type: 'member-removed', writerKey: normalizeHex(writerKey, 32), snapshot: result.snapshot !== false }
        : { type: 'member-removal-failed', reason: result.reason })
    return result.ok
}

// Can every device in the project understand a compaction barrier?
//
// Derived from the synced presence channel, not from a build note — the
// 2026-07-28 near-fork was a "mesh is ready" claim that was wrong about one
// peer. A REMOTE writer only counts as ready when it published its OWN heartbeat
// saying so. THIS device is passed separately: it is the build being asked, so
// its capability is known rather than observed — and a host with presence writes
// off (desktop) publishes no heartbeat at all, which used to make the owner count
// itself among the devices holding its own flatten back.
export async function computeCompactionReadiness() {
    try {
        const presence = reducePresence(await rebuildAllItems())
        return compactionReadiness(presence, membershipState?.writers, {
            localWriterKey: autobase?.local?.key ? autobase.local.key.toString('hex') : null,
        })
    } catch (e) {
        logger.log('[WARNING] Could not compute compaction readiness', e)
        return { ready: false, total: 0, readyCount: 0, blockers: [] }
    }
}

export async function compactHistory({ trigger = 'manual', dryRun = false } = {}) {
    const readiness = await computeCompactionReadiness()
    // The UI asks for readiness before it offers the button, so it can name the
    // device holding the flatten back instead of just greying something out.
    if (dryRun) {
        return {
            ok: false,
            reason: 'dry-run',
            dryRun: true,
            canCompact: readiness.ready && canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair),
            compacted: (Number(compactionState?.sequence) || 0) > 0,
            readiness,
        }
    }
    const result = await performCompaction({
        autobase,
        ownerAuthorityKeyPair,
        membershipState,
        compactionState,
        getAllItems: rebuildAllItems,
        prepareListAppendOperation,
        enqueueWrite,
        readiness,
        logger,
    })

    if (result.ok) {
        // Every outstanding invite predates the barrier, so its bootstrap data
        // would send a joiner into the history this just superseded.
        rotateInviteAndNotifyFrontend()
    }
    if (trigger === 'manual') {
        broadcastMessage({ type: 'compaction-result', ...result, readiness })
    } else if (!result.ok) {
        logger.log('[INFO] Automatic compaction skipped', { trigger, reason: result.reason })
    }
    return { ...result, readiness }
}

export async function broadcastCompactionReadiness() {
    const readiness = await computeCompactionReadiness()
    broadcastMessage({ type: 'compaction-readiness', ...readiness })
    return readiness
}

export async function resyncAuthorizedEpoch() {
    if (_epochResyncDone && epochResyncRecordMatchesMembership(_epochResyncRecord, membershipState)) {
        return { ok: true, skipped: true, reason: 'already-resynced' }
    }
    if (_epochResyncDone) {
        _epochResyncDone = false
        _epochResyncRecord = null
    }
    if (_epochResyncPromise) return _epochResyncPromise

    _epochResyncPromise = performEpochResync({
        autobase,
        epochKey,
        membershipState,
        ownerAuthorityKeyPair,
        getAllItems: rebuildAllItems,
        prepareListAppendOperation,
        enqueueWrite,
        waitForFlushableWriter,
        logger,
        publishGrant: publishEpochGrantToConnectedPeers,
    }).then((result) => {
        if (result.ok) {
            _epochResyncDone = true
            _epochResyncRecord = result.grantRecord || null
        }
        else if (!result.skipped) logger.log('[ERROR] Epoch resync did not complete', { reason: result.reason })
        else logger.log('[INFO] Epoch resync skipped', { reason: result.reason })
        return result
    }).finally(() => {
        _epochResyncPromise = null
    })
    return _epochResyncPromise
}

async function publishEpochGrantToChannel(channel, record) {
    if (!channel || !record) return false
    const acknowledged = await channel.sendGrant(record)
    logger.log('[AUDIT] Reused cached direct epoch grant for connected peer', { acknowledged })
    return acknowledged
}

async function publishEpochGrantToConnectedPeers(record) {
    const channels = [..._epochGrantChannels]
    if (channels.length === 0) return { attempted: 0, acknowledged: 0 }

    const acknowledgements = await Promise.all(channels.map((channel) => channel.sendGrant(record)))
    const acknowledged = acknowledgements.filter(Boolean).length
    logger.log('[AUDIT] Published direct epoch grant to connected peers', {
        attempted: channels.length,
        acknowledged,
    })
    return { attempted: channels.length, acknowledged }
}

async function acceptDirectEpochGrant(record) {
    if (!autobase?.key || !autobase?.local?.key || !epochEncryptionKeyPair) return false

    const adoption = validateDirectEpochGrant(record, {
        membershipState,
        baseKey: autobase.key,
        localWriterKey: autobase.local.key,
        epochEncryptionKeyPair,
        currentEpochKey: epochKey,
    })
    if (!adoption.ok) {
        logger.log('[WARNING] Rejected direct epoch grant', { reason: adoption.reason })
        return false
    }
    if (adoption.alreadyAdopted) return true

    setMembershipState(adoption.state)
    setEpochKey(adoption.epochKey)
    await saveEpochKey(adoption.epochKey)
    logger.log('[AUDIT] Adopted direct owner-signed epoch grant', {
        epoch: adoption.state.currentEpoch,
    })
    return true
}

// Build the membership roster for the frontend: who the writers are, which one
// is the owner, which one is this device, and whether this device can administer
// (hold owner authority). Writer keys are opaque public identifiers, not secrets.
export function broadcastMembershipRoster(ctx = primaryContext) {
    const localWriterKey = ctx.autobase?.local?.key ? ctx.autobase.local.key.toString('hex') : null
    const roster = buildMembershipRoster(ctx.membershipState, {
        localWriterKey,
        writable: !!ctx.autobase?.writable,
        hasOwnerAuthority: !!ctx.ownerAuthorityKeyPair && canCreateMembershipInvite(ctx.membershipState, ctx.ownerAuthorityKeyPair),
    })
    broadcastMessage({ type: 'membership-roster', roster })
}

// Reveal the owner recovery code so the owner can store it offline. Returns null
// unless this device currently holds owner authority. The code IS the owner
// secret — it is sent to the frontend for display only and never logged.
export function sendOwnerRecoveryCodeToFrontend() {
    if (!ownerAuthorityKeyPair || !canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) {
        logger.log('[WARNING] Owner recovery code requested but this device is not the owner')
        broadcastMessage({ type: 'owner-recovery-code', code: null, reason: 'not-owner' })
        return
    }
    const code = ownerRecoveryCodeFromKeyPair(ownerAuthorityKeyPair)
    logger.log('[AUDIT] Owner recovery code revealed to the owner for offline backup')
    broadcastMessage({ type: 'owner-recovery-code', code })
}

// Restore owner authority on this device from a recovery code. The code is
// verified against the owner public key the base records, so a wrong code (or a
// code for another base) is rejected without side effects.
export async function recoverOwnerAuthority(code) {
    if (!membershipState?.ownerAuthorityKey) {
        logger.log('[WARNING] Owner recovery requested but the base has no recorded owner')
        broadcastMessage({ type: 'owner-recovery-failed', reason: 'no-owner-on-base' })
        return { ok: false, reason: 'no-owner-on-base' }
    }
    if (ownerAuthorityKeyPair && canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) {
        broadcastMessage({ type: 'owner-recovered', alreadyOwner: true })
        return { ok: true, alreadyOwner: true }
    }

    const recovered = recoverOwnerAuthorityFromCode(code, membershipState.ownerAuthorityKey)
    if (!recovered) {
        logger.log('[WARNING] Owner recovery rejected an invalid or mismatched recovery code')
        broadcastMessage({ type: 'owner-recovery-failed', reason: 'invalid-code' })
        return { ok: false, reason: 'invalid-code' }
    }

    setOwnerAuthorityKeyPair(recovered)
    await saveOwnerAuthorityKey(recovered.secretKey)
    logger.log('[AUDIT] Owner authority recovered from recovery code')
    broadcastMembershipRoster()
    broadcastMessage({ type: 'owner-recovered' })
    return { ok: true }
}


function broadcastPeerCount() {
    broadcastMessage({ type: 'peer-count', count: peerCount })
}

// Map the live swarm/DHT state to the three states the header dot shows:
//   'online'     — on the p2p network (a peer is connected, or the DHT has
//                  bootstrapped and reports itself reachable). GREEN.
//   'offline'    — the DHT bootstrapped but its health monitor sees no
//                  reachable nodes (e.g. airplane mode). GREY.
//   'connecting' — no swarm yet, or the DHT is still bootstrapping. BLINKING.
// connections.size is the fast, definitive signal; dht.online is the
// (optimistic, health-monitored) fallback for the no-peers-but-online case.
// discovery.flushed() is deliberately NOT used: it resolves even when fully
// offline, so it cannot distinguish online from offline.
function currentNetworkStatus() {
    if (!swarm) return 'connecting'
    if ((swarm.connections?.size ?? 0) > 0) return 'online'
    const dht = swarm.dht
    if (!dht || !dht.bootstrapped) return 'connecting'
    return dht.online ? 'online' : 'offline'
}

function broadcastNetworkStatus() {
    let status = currentNetworkStatus()
    // A guest mid-join replicates over the temp swarm while the main swarm is
    // still finding the host on the DHT — never flash "no connection" then.
    if (status === 'offline' && isPendingJoinSuccess) status = 'connecting'
    if (status === _lastNetStatus) return
    _lastNetStatus = status
    broadcastMessage({ type: 'network-status', status })
}

// Subscribe to the DHT's reachability transitions for the current swarm. `gen`
// pins these handlers to the initAutobase pass that created the swarm, so a
// later base switch (which destroys this swarm/dht) can't deliver stale events.
function wireNetworkStatusSignals(gen) {
    const dht = swarm?.dht
    if (!dht) return
    const onUpdate = () => { if (gen === _netStatusGen) broadcastNetworkStatus() }
    if (dht.bootstrapped) onUpdate()
    else dht.once('ready', onUpdate)
    dht.on('network-update', onUpdate)
}

function broadcastJoinPhase(phase) {
    broadcastMessage({ type: 'join-phase', phase })
}

function broadcastMessage(payload) {
    if (!rpc) return
    try {
        const req = rpc.request(RPC_MESSAGE)
        req.send(JSON.stringify(payload))
    } catch (e) {
        logger.log('[ERROR] Failed to broadcast message', e)
    }
}

function swarmOptions() {
    return swarmBootstrap ? { bootstrap: swarmBootstrap } : {}
}

function normalizeInviteCode(raw) {
    if (typeof raw !== 'string') return ''
    return raw.trim().replace(/\s+/g, '')
}

function parseJoinCandidateUserData(userData) {
    if (!userData) return null

    try {
        const text = Buffer.from(userData).toString('utf8')
        const parsed = JSON.parse(text)
        const writerKey = normalizeHex(parsed?.writerKey, 32)
        const epochPublicKey = normalizeHex(parsed?.epochPublicKey, 32)
        if (writerKey) return { writerKey, epochPublicKey }
    } catch {}

    const writerKey = normalizeHex(Buffer.from(userData), 32)
    return writerKey ? { writerKey, epochPublicKey: null } : null
}

function normalizeHex(value, bytes) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const buffer = Buffer.from(value)
        return buffer.length === bytes ? buffer.toString('hex') : null
    }
    if (typeof value !== 'string') return null
    const hex = value.trim().toLowerCase()
    return /^[0-9a-f]+$/i.test(hex) && hex.length === bytes * 2 ? hex : null
}
