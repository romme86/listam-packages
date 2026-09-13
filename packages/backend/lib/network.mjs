import Hyperswarm from "hyperswarm"
import BlindPairing from "blind-pairing"
import z32 from "z32"
import { apply, open, primaryContext, resetApplyMembershipCheckpoint, resetSharedBasesOnBaseSwitch, storagePath, peerKeysString, keyFilePath, encKeyFilePath, ownerAuthorityKeyFilePath, legacyInviteFilePath, recoveryPolicy, swarmBootstrap } from "../backend.mjs"
import { saveAutobaseKey, saveEncryptionKey, saveOwnerAuthorityKey, deleteOwnerAuthorityKey, saveEpochKey, deleteEpochKey, saveEpochEncryptionKey, deleteEpochEncryptionKey, deleteLegacyInviteFile, deleteLegacyKeyFile } from "./key.mjs"
import { deleteBackendSecret, secretFingerprint } from "./secrets.mjs"
import { describeCorruption, isCorruptionSignature, planRecoveryAction, quarantineStorageRoot } from "./recovery.mjs"
import { inviteExpiresInMs, withInvitePolicy } from "./invite-policy.mjs"
import { addInvite, clearInvites, createInviteBook, describeInvites, findInvite, newestUsableInvite, reserveInvite } from "./invite-book.mjs"
import { getRelayKeys, relayFingerprints, relaySwarmOptions, setRelayKeys } from "./relay.mjs"
import { createJoinRollbackSnapshot, restoreJoinRollbackSnapshot } from "./join-rollback.mjs"
import { createAutoBackup } from "./auto-backup.mjs"
import { performMemberRemovalRekey } from "./rekey.mjs"
import { epochResyncRecordMatchesMembership, performEpochResync } from './epoch-resync.mjs'
import { createEpochGrantChannel } from './epoch-grant-channel.mjs'
import { createJoinWatch } from './join-watch.mjs'
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
import { PAIRING_POLL_MS, JOIN_DEADLINE_MS, JOIN_HEARTBEAT_MS, DENY_STATUS, JOIN_REASON, denyStatusForReason, joinFailureReason, refineTimeoutReason } from "./pairing-tuning.mjs"
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
import { getNetworkSwarms } from '../backend.mjs'
import { createSwarmLifecycle } from './swarm-lifecycle.mjs'

let _initPromise = null
// Every code the owner has handed out that is still alive. One slot used to
// mean minting a code for the second friend silently killed the first.
const inviteBook = createInviteBook()
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
}

export function waitForWritable({ startedAt } = {}) {
    endJoinWatch()
    const gen = ++_joinGeneration
    // The view length is an exact, O(1) answer to "has anything new linearized?",
    // so the expensive rebuild+push only runs when there is genuinely more to
    // show — not on every wake-up.
    let pushedAtViewLength = -1
    let busy = false
    let phase = 'writable'

    const base = autobase
    const mainSwarm = swarm
    const current = () => gen === _joinGeneration && isPendingJoinSuccess && autobase === base

    function finish(kind, message, reason = JOIN_REASON.TIMEOUT) {
        if (!current()) return
        endJoinWatch()
        _joinAbort = null
        setIsPendingJoinSuccess(false)
        broadcastMessage(kind === 'error' ? { type: 'join-error', reason, message } : { type: 'join-success' })
        broadcastNetworkStatus()
        cleanupTempSwarm()
    }

    async function syncWhatHasArrived() {
        const viewLength = base?.view?.length ?? 0
        if (viewLength === pushedAtViewLength) return
        pushedAtViewLength = viewLength
        try {
            const list = await rebuildListFromPersistedOps()
            if (!current()) return
            setCurrentList(list)
            if (list.length > 0) syncListToFrontend(list)
            const extraItems = await rebuildExtraListItems()
            if (current()) projectItemsToFrontend(extraItems)
        } catch (e) {
            logger.log('[WARNING] join watch: partial sync failed:', e?.message ?? e)
        }
    }

    async function evaluate() {
        if (!current() || busy) return
        busy = true
        try {
            try {
                if (base) await base.update()
            } catch (e) {
                logger.log('[ERROR] join watch: autobase.update failed:', e?.message ?? e)
            }
            if (!current()) return
            await syncWhatHasArrived()
        } finally {
            busy = false
        }
    }

    const watch = createJoinWatch({
        base,
        swarm: mainSwarm,
        isCurrent: current,
        timeoutMs: JOIN_NO_PROGRESS_TIMEOUT_MS,
        pollMs: JOIN_FALLBACK_POLL_MS,
        heartbeatMs: JOIN_HEARTBEAT_MS,
        startedAt,
        onCheck(progress) {
            // Drop the temp swarm as soon as the main one is up, so the host does
            // not count this guest twice.
            if (_tempSwarm && swarm?.connections?.size > 0) {
                logger.log('[INFO] Main swarm connected, cleaning up temp swarm')
                cleanupTempSwarm()
            }

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
            // Kick one update/projection at a time. The watch samples progress,
            // writability and its deadline even while these reads are pending.
            void evaluate()
        },
        onTimeout() {
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
        },
        onHeartbeat(elapsedMs) {
            const snapshot = { phase: phase === 'writable' ? 'permission' : phase, elapsedMs, viewLength: base?.view?.length ?? 0, ...joinTransportSnapshot() }
            logger.log('[INFO] Join waiting for project sync', snapshot)
            broadcastMessage({ type: 'join-progress', ...snapshot })
        },
    })
    const cancel = () => finish('error', 'Join cancelled', JOIN_REASON.CANCELLED)
    _joinAbort = cancel
    _joinDetach = () => {
        watch.stop()
        if (_joinAbort === cancel) _joinAbort = null
    }

    // Evaluate once immediately: the guest may already be writable.
    watch.check()
}

export function createInvite({ fresh = false } = {}) {
    if (!autobase) return null
    if (!canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) {
        clearInvites(inviteBook)
        logger.log('[WARNING] Invite creation rejected; only the owner device can create or revoke invites')
        return null
    }

    // Reuse the newest live code unless the caller explicitly asked for a new
    // one. Re-rendering the share sheet must not mint (it would churn a fresh
    // code on every backend event); tapping "new code" must. Codes minted for
    // earlier friends stay valid alongside it — each is separately single-use.
    //
    // An invite's signed additional data carries the epoch key the joiner
    // bootstraps from, so entries minted under a rotated epoch are never reused.
    const currentEpoch = Number(membershipState?.currentEpoch) || 0
    if (!fresh) {
        const existing = newestUsableInvite(inviteBook, currentEpoch)
        if (existing) return z32.encode(existing.invite)
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
    const entry = addInvite(inviteBook, inv, { epochAtMint: currentEpoch })
    deleteLegacyInviteFile(legacyInviteFilePath)
    logger.log('[INFO] Invite minted', describeInvites(inviteBook, currentEpoch))

    return z32.encode(entry.invite)
}

// Retire EVERY outstanding code and publish a fresh one.
//
// Used when something invalidates the whole book at once rather than one entry:
// an epoch rotation (outstanding invites embed the retired epoch key in their
// signed additional data) or a history-compaction barrier (they would send a
// joiner into history the barrier just superseded). Note the compaction case
// does not change the epoch, so relying on the per-entry epoch check would miss
// it — these must be dropped explicitly.
function retireAllInvitesAndNotify() {
    clearInvites(inviteBook)
    deleteLegacyInviteFile(legacyInviteFilePath)
    notifyInviteState({ mint: true })
}

// Re-publish the invite state after a use or a refusal. This no longer mints
// unconditionally: the other live codes are still good, and minting on every
// candidate would rotate the sharer's displayed code out from under them.
function notifyInviteState({ mint = false } = {}) {
    const nextZ32 = mint ? createInvite({ fresh: true }) : createInvite()
    sendInviteKeyToFrontend(nextZ32 || '')
}

// The sharer has never been told that a code is single-use or that it expires in
// ten minutes, so "it stopped working" reads as a bug. Send the facts alongside
// the code.
//
// Shape change: this used to send the bare z32 string. Consumers must accept
// both — an older UI paired with this backend still gets a usable code out of
// the envelope only if it parses, so the raw-string fallback lives on the
// reading side (see @listam/client).
export function sendInviteKeyToFrontend(inviteKey) {
    if (!rpc) return
    const currentEpoch = Number(membershipState?.currentEpoch) || 0
    const summary = describeInvites(inviteBook, currentEpoch)
    const req = rpc.request(RPC_GET_KEY)
    req.send(JSON.stringify({
        key: inviteKey,
        expiresAt: summary.newestExpiresAt,
        expiresInMs: summary.newestExpiresAt ? Math.max(0, summary.newestExpiresAt - Date.now()) : 0,
        singleUse: true,
        liveInvites: summary.live,
        maxInvites: summary.max,
    }))
}

// Refuse a candidate so the GUEST HEARS IT.
//
// This used to be `try { candidate.close() } catch (_) {}` at six separate
// sites. `close()` does not exist on blind-pairing-core's MemberRequest — its
// methods are confirm/deny/respond/open (blind-pairing-core/index.js:170-245) —
// so every refusal threw TypeError into an empty catch and did nothing at all.
// With no response written, the member never mutablePuts a reply
// (blind-pairing/index.js:477-490) and the guest waits out its entire deadline.
// Host refused / host unreachable / host never existed were indistinguishable,
// which is why a two-minute spinner was the only diagnostic anyone ever got.
//
// `deny()` seals its reply with the invite's session and public key, both of
// which are only populated by `open()` — so a candidate we cannot open is a
// candidate we cannot answer. That is not a gap we can close: an unknown invite
// id means we hold no key for it. Log it instead, and let the guest time out
// knowing at least that the host never recognised the code.
function refuseCandidate(candidate, { publicKey = null, status = DENY_STATUS.REJECTED, reason, context = {} }) {
    if (status === null) {
        logger.log('[WARNING] Pairing candidate refused with no reply possible', { reason, ...context })
        return false
    }
    try {
        if (publicKey) candidate.open(publicKey)
        candidate.deny({ status })
        logger.log('[WARNING] Pairing candidate denied', { reason, status, ...context })
        return true
    } catch (e) {
        logger.log('[ERROR] Failed to deny pairing candidate', { reason, error: e?.message ?? String(e) })
        return false
    }
}

export function setupBlindPairing() {
    if (!autobase || !swarm) return

    // Short poll: see PAIRING_POLL_MS. Without it the NAT-free DHT mailbox is
    // read once per seven minutes and is unreachable inside a join.
    setPairing(new BlindPairing(swarm, { poll: PAIRING_POLL_MS }))

    setPairingMember(pairing.addMember({
        discoveryKey: autobase.discoveryKey,
        onadd: async (candidate) => {
            const reservedInvite = findInvite(inviteBook, candidate.inviteId)
            if (!reservedInvite) {
                refuseCandidate(candidate, {
                    status: null,
                    reason: 'unknown-invite',
                    context: { liveInvites: inviteBook.entries.size },
                })
                return
            }

            const reservation = reserveInvite(inviteBook, reservedInvite)
            if (!reservation.ok) {
                refuseCandidate(candidate, {
                    publicKey: reservedInvite.publicKey,
                    status: denyStatusForReason(reservation.reason),
                    reason: reservation.reason,
                })
                notifyInviteState()
                return
            }

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
                // Already opened above, so the guest can be told. The entry is
                // left in the book as a spent tombstone (the reservation above
                // consumed it): deleting it would make the next holder of this
                // same code unanswerable, which is the silence we are removing.
                refuseCandidate(candidate, { status: DENY_STATUS.REJECTED, reason: 'accept-failed' })
            } finally {
                notifyInviteState()
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
        clearInvites(inviteBook)
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

        setSwarm(registerNetworkSwarm(new Hyperswarm(swarmOptions())))
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
// Set while a join is in flight so RPC_CANCEL_JOIN can abort it. Without this,
// the single-flight guard below turned every retry into a lie: a user who
// pasted a fresh code while an attempt was stuck silently re-attached to the
// STUCK attempt, the new code was never even decoded, and when the old attempt
// finally expired its failure was reported against the new code.
let _joinAbort = null

/**
 * Abort an in-flight join. Idempotent and safe to call when nothing is running.
 * @returns {boolean} whether there was anything to cancel
 */
export function cancelJoinViaInvite() {
    if (!_joinAbort) return false
    logger.log('[INFO] Join cancelled by request')
    const abort = _joinAbort
    _joinAbort = null
    abort()
    return true
}

export async function joinViaInvite(z32InviteStr) {
    if (_joinPromise) {
        logger.log('[WARNING] joinViaInvite already running — returning existing join promise')
        return _joinPromise
    }

    _joinPromise = (async () => {
        const startedAt = Date.now()
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
            _tempSwarm = registerNetworkSwarm(new Hyperswarm(swarmOptions()))
            // Short poll on the guest side too: the candidate reads the DHT
            // reply mailbox before it announces (blind-pairing/index.js:651-668),
            // so at the library default of seven minutes the very first read is
            // the only one that ever happens inside our deadline — and it
            // happens before the host could have answered.
            _tempPairing = new BlindPairing(_tempSwarm, { poll: PAIRING_POLL_MS })

            // A failed join used to leave three log lines and two minutes of
            // silence. Record what the transport was actually doing, so the next
            // field report is evidence instead of "it didn't work".
            _tempSwarm.on('error', (err) => logger.log('[ERROR] Join temp swarm error', { error: err?.message ?? String(err) }))
            _tempSwarm.on('connection', () => {
                logger.log('[INFO] Join temp swarm connection', { connections: _tempSwarm?.connections?.size ?? 0 })
            })

            const result = await new Promise((resolve, reject) => {
                let settled = false

                const finish = (fn, arg) => {
                    if (settled) return
                    settled = true
                    clearTimeout(timeout)
                    clearInterval(heartbeat)
                    _joinAbort = null
                    fn(arg)
                }

                const timeout = setTimeout(() => {
                    const net = joinTransportSnapshot()
                    logger.log('[ERROR] Pairing deadline expired', net)
                    const err = new Error('Pairing timed out')
                    err.reason = refineTimeoutReason(JOIN_REASON.TIMEOUT, net)
                    finish(reject, err)
                }, JOIN_DEADLINE_MS)

                // Every tick is one line and one UI update. It is what tells the
                // difference between "never reached the DHT", "on the DHT but
                // never found the host", and "found the host, got refused" —
                // three failures that were previously one spinner.
                const heartbeat = setInterval(() => {
                    const net = joinTransportSnapshot()
                    const elapsedMs = Date.now() - startedAt
                    logger.log('[INFO] Join still pairing', { elapsedMs, ...net })
                    broadcastMessage({ type: 'join-progress', phase: 'pairing', elapsedMs, ...net })
                }, JOIN_HEARTBEAT_MS)

                _joinAbort = () => {
                    const err = new Error('Join cancelled')
                    err.reason = JOIN_REASON.CANCELLED
                    finish(reject, err)
                }

                const candidate = _tempPairing.addCandidate({
                    invite: z32.decode(normalizedInvite),
                    userData: Buffer.from(JSON.stringify({
                        version: 1,
                        writerKey: localWriterKey.toString('hex'),
                        epochPublicKey: epochPublicKeyHex(joinEpochEncryptionKeyPair),
                    })),
                    onadd: async (paired) => {
                        finish(resolve, paired)
                        // NOTE: do NOT call candidate.close() here — it kills
                        // the connection we need for replication bootstrapping.
                    }
                })

                // The host CAN now tell us why it said no (see refuseCandidate).
                // Discarding this handle is what made the host-side fix
                // invisible: blind-pairing-core emits 'rejected' on the request
                // (blind-pairing-core/index.js:85) and nothing was listening.
                candidate?.request?.on?.('rejected', (err) => {
                    logger.log('[WARNING] Pairing refused by host', { code: err?.code ?? null })
                    const refusal = new Error(err?.message || 'Pairing refused')
                    refusal.reason = joinFailureReason(err)
                    finish(reject, refusal)
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
                waitForWritable({ startedAt })
            }
        } catch (e) {
            // Diagnostics ride as a separate argument, never hung off the
            // Error: redactForLog reduces any Error to {name, message}
            // (@listam/logging index.mjs:64), so context attached to it is
            // silently dropped.
            const reason = e?.reason || joinFailureReason(e)
            logger.log('[ERROR] joinViaInvite failed:', e, { reason, ...joinTransportSnapshot() })
            setIsPendingJoinSuccess(false)
            broadcastMessage({
                type: 'join-error',
                reason,
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
        retireAllInvitesAndNotify()
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
        retireAllInvitesAndNotify()
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

// Relay keys resolved once at boot. Parsing per swarm would re-log the same
// rejected entry on every join.
export function configureRelays(value) {
    const { keys, rejected } = setRelayKeys(value)
    if (rejected.length) {
        logger.log('[WARNING] Ignoring unparseable relay keys', { count: rejected.length })
    }
    logger.log('[INFO] Relay configuration', {
        configured: keys.length,
        fingerprints: relayFingerprints(keys),
    })
    return keys.length
}

// Every Hyperswarm in the backend must be built from this, including the
// short-lived pairing swarm — a guest that relays its data connections but not
// its pairing connection still cannot pair over mobile data.
function swarmOptions() {
    return relaySwarmOptions(swarmBootstrap, {
        onEngage: (info) => logger.log('[INFO] Relaying connections through a relay peer', info),
    })
}

/**
 * A snapshot of what the transport is actually doing, for logs, the join
 * heartbeat and RPC_GET_NET_DIAGNOSTICS.
 *
 * `randomized` is the load-bearing field: true means this device's NAT assigns a
 * fresh port per destination (every carrier network), which is the condition
 * under which hyperdht refuses to holepunch at all unless a relay is configured.
 */
export function joinTransportSnapshot() {
    const dht = _tempSwarm?.dht ?? swarm?.dht ?? null
    return {
        bootstrapped: dht?.bootstrapped ?? false,
        online: dht?.online ?? false,
        firewalled: dht?.firewalled ?? null,
        randomized: dht?.randomized ?? null,
        punches: dht?.stats?.punches ?? null,
        relaying: dht?.stats?.relaying ?? null,
        socketPool: dht?.stats?.socketPool ? { ...dht.stats.socketPool } : null,
        relayConfigured: getRelayKeys().length,
        tempConnections: _tempSwarm?.connections?.size ?? 0,
        mainConnections: swarm?.connections?.size ?? 0,
    }
}

// --- Mobile lifecycle -------------------------------------------------------
//
// Bare Kit already suspends the worklet's event loop when the app backgrounds
// (react-native-bare-kit/index.js:332 wires AppState to it at import time), but
// nothing told the swarm. hyperswarm's suspend()/resume() (index.js:606,642)
// exist for exactly this: resume() re-binds fresh UDP sockets through
// dht-rpc's io.resume() (dht-rpc/lib/io.js:217) and re-announces. Without it a
// host that left the app to send an invite code came back with dead sockets and
// an expired announce, and simply stopped being reachable.

const networkLifecycle = createSwarmLifecycle({
    getSwarms: () => [...getNetworkSwarms(), _tempSwarm],
    onError: (error) => logger.log('[ERROR] Swarm lifecycle failed', { error: error?.message ?? String(error) }),
})

export function registerNetworkSwarm(swarm) {
    networkLifecycle.register(swarm)
    return swarm
}

export function networkLifecycleSnapshot() {
    return networkLifecycle.snapshot()
}

export async function suspendNetwork() {
    return networkLifecycle.suspend()
}

export async function resumeNetwork() {
    const resumed = await networkLifecycle.resume()
    // Hyperswarm.resume() already resumes every discovery topic. Waiting for
    // flushed() here makes unavailable peers block the foreground recovery.
    broadcastNetworkStatus()
    return resumed
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
