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

import { autobase, swarm } from './state.mjs'
import { updateItem, rebuildExtraListItems } from './item.mjs'
import { buildPresenceItem, reducePresence, PRESENCE_HEARTBEAT_MS } from '@listam/domain/presence'
import { logger } from './logger.mjs'

let _timer = null
let _started = false
let _lastAccrualAt = 0
let _cumulativeOnlineMs = 0
let _sessionCount = 0
let _sessionStartedAt = 0
let _lastInteractionAt = 0
let _lastWriteAt = 0

function nowMs () { return Date.now() }

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

// Record that THIS device just performed a real (non-presence) mutation. In-memory
// only — the next scheduled heartbeat carries it, so a mutation never adds a write.
export function notePresenceInteraction () {
    _lastInteractionAt = nowMs()
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

    _timer = setInterval(() => { tick() }, PRESENCE_HEARTBEAT_MS)
    _timer?.unref?.()

    await writeHeartbeat({ final: false })
}

export function stopPresenceHeartbeat () {
    if (_timer) { clearInterval(_timer); _timer = null }
}

// Prompt an immediate beat (e.g. right after the base became writable) so a peer
// appears online without waiting a full cadence. No-op before start.
export function pokePresence () {
    if (!_started) return
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
