// Backend-driven presence heartbeat. The device self-publishes ONE synced
// presence item (id = its own writerKey, @listam/domain/presence) and refreshes it
// on a cadence while it is writable AND on the p2p network. That single item gives
// every peer this device's online-now / last-seen / last-interaction / avg-online
// without any noise-key<->writerKey correlation.
//
// Backend-driven (not frontend-driven like the peer-name label) because headless
// nodes have no UI. Host-agnostic: plain timers + the ordinary updateItem() write
// path work identically under Node (headless), Bare Kit (mobile) and Pear (desktop).
//
// Cost control (the one real risk — heartbeats append to an append-only log with
// no compaction yet) lives entirely here: at most one append per cadence, only
// while online+writable, mutations add no extra writes (they just stamp
// lastInteractionAt in memory for the next beat), and the cadence is one tunable
// constant in the domain module.

import { autobase, swarm, membershipState, ownerAuthorityKeyPair } from './state.mjs'
import { updateItem, rebuildExtraListItems } from './item.mjs'
import {
    buildAttestedPresenceItem,
    buildPresenceItem,
    reducePresence,
    PRESENCE_HEARTBEAT_MS,
} from '@listam/domain/presence'
import { canCreateMembershipInvite } from './membership.mjs'
import { logger } from './logger.mjs'

let _timer = null
let _started = false
let _writesEnabled = true
let _lastAccrualAt = 0
let _cumulativeOnlineMs = 0
let _sessionCount = 0
let _sessionStartedAt = 0
let _lastInteractionAt = 0
let _lastWriteAt = 0
let _observedTimer = null
const _pendingObservedAt = new Map()
const _lastObservedWriteAt = new Map()

// Observer writes happen only for legacy peers without self-heartbeats. Coalesce
// bursts so replay/apply batches cannot turn one user action into write noise.
const OBSERVED_ACTIVITY_DEBOUNCE_MS = 100
const OBSERVED_ACTIVITY_MIN_WRITE_MS = 30_000

function nowMs () { return Date.now() }

export function setPresenceWritesEnabled (enabled = true) {
    _writesEnabled = enabled !== false
    if (!_writesEnabled) stopPresenceHeartbeat()
}

function localWriterKeyHex () {
    try { return autobase?.local?.key ? autobase.local.key.toString('hex') : null } catch { return null }
}

// On the p2p network: a live peer connection, or the DHT reports itself reachable.
// Mirrors network.mjs currentNetworkStatus() without importing it (keeps this
// module one-way dependent — network.mjs drives the lifecycle, not vice-versa).
function isOnline () {
    try {
        if ((swarm?.connections?.size ?? 0) > 0) return true
        return swarm?.dht?.online === true
    } catch { return false }
}

// Is anyone actually there to receive a beat?
//
// Presence is telemetry ABOUT this device FOR its peers, and it only reaches a
// peer over a live connection. A beat written while nothing is connected cannot
// be observed by anyone: by the time a peer arrives, `pokePresence` on that
// connection publishes a fresh one that supersedes it. Those beats are pure
// cost — and the cost is not small, because the base is append-only with no
// compaction. Measured marginal cost of one beat: ~17.3 KB across the writer
// core, the view and the corestore index, i.e. ~12.5 MB per device per DAY at
// the 120s cadence, ~4.5 GB per device-year. An always-on peer alone on the
// network was paying all of that to tell nobody anything.
//
// Deliberately distinct from isOnline(): reachability still governs ACCRUAL, so
// avg-online keeps counting while this device is genuinely up and reachable. It
// is only the append that waits for an audience.
function hasAudience () {
    try {
        return (swarm?.connections?.size ?? 0) > 0
    } catch { return false }
}

// Record that THIS device just performed a real (non-presence) mutation. In-memory
// only — the next scheduled heartbeat carries it, so a mutation never adds a write.
export function notePresenceInteraction () {
    _lastInteractionAt = nowMs()
}

// Record a real operation authored by ANOTHER active writer. The operation's
// own updatedAt is used as the observation time (capped at the owner's clock),
// so an old historical replay cannot make a long-offline device look newly
// online. Only the owner may attest and only for current members.
export function noteObservedWriterActivity (writerKey, observedAt = 0) {
    if (!_writesEnabled) return false
    const key = typeof writerKey === 'string' ? writerKey.trim().toLowerCase() : ''
    if (!key || key === localWriterKeyHex()) return false
    if (!membershipState?.writers?.has?.(key)) return false
    if (!canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) return false

    const rawObservedAt = Number(observedAt)
    const at = Number.isFinite(rawObservedAt) && rawObservedAt > 0
        ? Math.min(rawObservedAt, nowMs())
        : nowMs()
    const previous = _pendingObservedAt.get(key) || 0
    if (at > previous) _pendingObservedAt.set(key, at)
    if (!_observedTimer) {
        _observedTimer = setTimeout(flushObservedWriterActivity, OBSERVED_ACTIVITY_DEBOUNCE_MS)
        _observedTimer?.unref?.()
    }
    return true
}

// Stop the timer and zero the accounting. Called on a base switch/teardown so the
// next base starts a fresh session and re-seeds from its OWN last presence item
// (never carries the previous base's accrual).
export function resetPresenceAccounting () {
    stopPresenceHeartbeat()
    _started = false
    _lastAccrualAt = 0
    _cumulativeOnlineMs = 0
    _sessionCount = 0
    _sessionStartedAt = 0
    _lastInteractionAt = 0
    _lastWriteAt = 0
    _lastObservedWriteAt.clear()
}

// Idempotent. Seeds cumulative/session totals from this device's own last persisted
// presence item (so avg-online is continuous across restarts), counts a new
// session, arms the cadence timer, and fires a first (self-gated) beat.
export async function startPresenceHeartbeat () {
    if (_started) return
    _started = true
    const now = nowMs()
    _sessionStartedAt = now
    _lastAccrualAt = now
    _lastInteractionAt = _lastInteractionAt || now

    try {
        const key = localWriterKeyHex()
        if (key) {
            const prior = reducePresence(await rebuildExtraListItems()).get(key)
            if (prior) {
                _cumulativeOnlineMs = Math.max(0, Number(prior.cumulativeOnlineMs) || 0)
                _sessionCount = Math.max(0, Number(prior.sessionCount) || 0)
                if (Number(prior.lastInteractionAt) > 0) _lastInteractionAt = Number(prior.lastInteractionAt)
            }
        }
    } catch (e) {
        logger.log('[WARNING] presence: seeding from prior item failed:', e?.message ?? e)
    }
    _sessionCount += 1

    // Desktop presence is telemetry, never a prerequisite for editing. The
    // desktop host disables these writes because an Autobase append can remain
    // pending during boot-time replication and occupy the user write queue.
    if (!_writesEnabled) return

    _timer = setInterval(() => { tick() }, PRESENCE_HEARTBEAT_MS)
    _timer?.unref?.()

    await writeHeartbeat({ final: false })
}

export function stopPresenceHeartbeat () {
    if (_timer) { clearInterval(_timer); _timer = null }
    if (_observedTimer) { clearTimeout(_observedTimer); _observedTimer = null }
    _pendingObservedAt.clear()
}

// Prompt an immediate beat (e.g. right after the base became writable) so a peer
// appears online without waiting a full cadence. No-op before start.
export function pokePresence () {
    if (!_started || !_writesEnabled) return
    tick()
}

function tick () {
    writeHeartbeat({ final: false }).catch((e) => logger.log('[WARNING] presence beat failed:', e?.message ?? e))
}

function accrue (now) {
    if (_lastAccrualAt > 0) {
        const delta = now - _lastAccrualAt
        // Count at most one interval per beat and never negative: a long suspended
        // gap (e.g. a backgrounded phone) or a backwards clock is clamped away.
        if (delta > 0) _cumulativeOnlineMs += Math.min(delta, PRESENCE_HEARTBEAT_MS * 1.5)
    }
    _lastAccrualAt = now
}

export async function writeHeartbeat ({ final = false } = {}) {
    if (!_writesEnabled) return false
    const key = localWriterKeyHex()
    // Can't write unless we have a local key and the base is writable. Keep the
    // accrual clock current so the next writable+online beat doesn't back-count the
    // not-writable/offline gap.
    if (!key || !autobase?.writable) { _lastAccrualAt = nowMs(); return false }
    // Skip when offline even on a final flush: an offline write cannot replicate
    // and would stall up to FLUSHABLE_WAIT_MS on a cut-off writer (delaying
    // shutdown); we lose at most one partial interval of accrual.
    if (!isOnline()) { _lastAccrualAt = nowMs(); return false }

    const now = nowMs()
    accrue(now)

    // Nobody connected: keep accruing, write nothing. The accrued total is not
    // lost — it rides the next beat, which `pokePresence` fires as soon as a peer
    // connects. A `final` flush still writes, so a clean shutdown records the
    // session even if the last peer just left.

    // Nobody connected: keep accruing, write nothing. The accrued total is not
    // lost — it rides the next beat, which `pokePresence` fires as soon as a peer
    // connects. A `final` flush still writes, so a clean shutdown records the
    // session even if the last peer just left.
    if (!final && !hasAudience()) return false

    // Coalesce: at most one append per cadence. A poke/first-beat with a stale
    // _lastWriteAt passes; a poke right after a beat is skipped (already fresh).
    if (!final && (now - _lastWriteAt) < PRESENCE_HEARTBEAT_MS * 0.9) return false

    const item = buildPresenceItem({
        writerKey: key,
        lastActiveAt: now,
        lastInteractionAt: _lastInteractionAt || 0,
        sessionStartedAt: _sessionStartedAt || now,
        cumulativeOnlineMs: _cumulativeOnlineMs,
        sessionCount: _sessionCount,
        updatedAt: now,
    })
    const ok = await updateItem(item, null)
    if (ok) _lastWriteAt = now
    return ok
}

async function flushObservedWriterActivity () {
    _observedTimer = null
    if (_pendingObservedAt.size === 0) return

    // Same gate the heartbeat uses, and for the same reason it gives: an offline
    // or non-writable write cannot replicate and stalls up to FLUSHABLE_WAIT_MS
    // inside the SERIALIZED write chain — so it does not merely delay itself, it
    // holds up every other write behind it. During a join that is the join's own
    // write access, which then times out.
    //
    // This attestation is best-effort telemetry: keep the pending observations
    // and let the next noteObservedWriterActivity schedule another flush, rather
    // than block anything for them.
    if (!autobase?.writable || !isOnline()) return

    const pending = [..._pendingObservedAt.entries()]
    _pendingObservedAt.clear()

    try {
        if (!canCreateMembershipInvite(membershipState, ownerAuthorityKeyPair)) return
        const ownerKey = localWriterKeyHex()
        if (!ownerKey) return
        const presence = reducePresence(await rebuildExtraListItems())

        for (const [writerKey, observedAt] of pending) {
            if (!membershipState?.writers?.has?.(writerKey) || writerKey === ownerKey) continue
            const existing = presence.get(writerKey) || null
            // A null attestedBy means this writer supports and publishes its own
            // richer heartbeat. Never overwrite it with observer data.
            if (existing && !existing.attestedBy) continue
            if ((Number(existing?.lastActiveAt) || 0) >= observedAt) continue
            const lastWrite = _lastObservedWriteAt.get(writerKey) || 0
            if (lastWrite > 0 && (observedAt - lastWrite) < OBSERVED_ACTIVITY_MIN_WRITE_MS) continue

            const item = buildAttestedPresenceItem({
                writerKey,
                observedAt,
                attestedBy: ownerKey,
                existing,
            })
            if (await updateItem(item, null)) {
                _lastObservedWriteAt.set(writerKey, observedAt)
                presence.set(writerKey, reducePresence([item]).get(writerKey))
            }
        }
    } catch (e) {
        logger.log('[WARNING] presence: owner activity attestation failed:', e?.message ?? e)
    }
}
