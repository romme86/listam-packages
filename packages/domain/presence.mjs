// A synced "presence" channel that rides the ordinary item pipeline exactly like
// the label channels (labels.mjs): a reserved listId/listType bucket whose items
// carry the full base item shape — `text:''`, `isDone:false`, `timeOfCompletion:0`,
// `updatedAt` — so an older peer's strict normalizeListItem accepts and stores
// them, plus the numeric presence fields below. A brand-new listType hits no
// existing apply()/reduce branch, so it cannot fork the base; it simply lands in a
// bucket older peers never render. Every surface's list filter must skip this type;
// it is folded into labels.mjs `isLabelItem`, which every projection/nav gate
// already calls, so the skip is automatic everywhere.
//
// Each device authors exactly ONE item, id = its own writerKey (hex), and refreshes
// it on a heartbeat cadence while online+writable. It advertises the device's own
// observed presence:
//   • lastActiveAt       — wall-clock of this heartbeat → online-now (recent) + last-seen
//   • lastInteractionAt  — wall-clock of this device's last real mutation → last ping
//   • sessionStartedAt   — when the current online session began → "online since"
//   • cumulativeOnlineMs — total observed online time across sessions (self-accounted)
//   • sessionCount       — number of online sessions → avg = cumulativeOnlineMs / sessionCount
// Self-asserted: a current device writes its OWN key, so there is no contention;
// LWW by updatedAt (== lastActiveAt on a heartbeat). During rolling upgrades the
// owner may also publish an observer-attested entry for an older writer that has
// no heartbeat support. `attestedBy` identifies that owner; it is null on a
// normal self-published beat, which always takes over after the old client upgrades.

export const PRESENCE_LIST_ID = '__presence__'
export const PRESENCE_LIST_TYPE = 'presence'

// The heartbeat write cadence and the online-now staleness threshold. The
// threshold is ~2.5× the cadence so a single dropped or late beat does not flip a
// peer offline. Both live here so the backend writer and both UIs agree.
export const PRESENCE_HEARTBEAT_MS = 120_000
export const PRESENCE_ONLINE_THRESHOLD_MS = 300_000

export function isPresenceItem (item) {
    return !!item && typeof item === 'object' && item.listType === PRESENCE_LIST_TYPE
}

function numberOr (value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// Build THIS device's presence item. `writerKey` (hex) is both the item id and a
// convenience mirror so a consumer that only has the item (not the roster) can
// still recover the key. All timing fields default to 0 = unknown. `updatedAt`
// defaults to `lastActiveAt` so a plain heartbeat monotonically wins the LWW merge.
export function buildPresenceItem ({
    writerKey,
    lastActiveAt = 0,
    lastInteractionAt = 0,
    sessionStartedAt = 0,
    cumulativeOnlineMs = 0,
    sessionCount = 0,
    updatedAt,
    attestedBy = null,
    compaction = 0,
} = {}) {
    const key = String(writerKey ?? '')
    const active = numberOr(lastActiveAt, 0)
    return {
        id: key,
        listId: PRESENCE_LIST_ID,
        listType: PRESENCE_LIST_TYPE,
        // Full base item shape so normalizeListItem (list-reducer.mjs) accepts it
        // on every peer, new or old.
        text: '',
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: numberOr(updatedAt, active),
        writerKey: key,
        lastActiveAt: active,
        lastInteractionAt: numberOr(lastInteractionAt, 0),
        sessionStartedAt: numberOr(sessionStartedAt, 0),
        cumulativeOnlineMs: Math.max(0, numberOr(cumulativeOnlineMs, 0)),
        sessionCount: Math.max(0, numberOr(sessionCount, 0)),
        attestedBy: typeof attestedBy === 'string' && attestedBy ? attestedBy : null,
        // What this build can do, so a mesh-wide decision can be made from
        // OBSERVED fact instead of a judgement call. On 2026-07-28 a "mesh is
        // ready" note was wrong and would have forked the base — the geekom read
        // the rollout flag but had no keyring. An older peer simply has no such
        // field, and absent reads as "not capable", which is the safe verdict.
        compaction: Math.max(0, numberOr(compaction, 0)),
    }
}

// Build an owner-observed presence entry for a legacy writer. Preserve any
// accumulated fields from an earlier attestation; only last-active/interaction
// advance. The backend deliberately does not call this when a self-published
// (attestedBy=null) entry exists, so observer data never replaces a modern
// device's richer session accounting.
export function buildAttestedPresenceItem ({
    writerKey,
    observedAt = 0,
    attestedBy,
    existing = null,
} = {}) {
    const observed = Math.max(0, numberOr(observedAt, 0))
    return buildPresenceItem({
        writerKey,
        lastActiveAt: Math.max(numberOr(existing?.lastActiveAt, 0), observed),
        lastInteractionAt: Math.max(numberOr(existing?.lastInteractionAt, 0), observed),
        sessionStartedAt: numberOr(existing?.sessionStartedAt, 0),
        cumulativeOnlineMs: Math.max(0, numberOr(existing?.cumulativeOnlineMs, 0)),
        sessionCount: Math.max(0, numberOr(existing?.sessionCount, 0)),
        updatedAt: Math.max(numberOr(existing?.updatedAt, 0), observed),
        attestedBy,
    })
}

// Reduce presence items to Map<writerKeyHex, entry>: newest updatedAt wins per id.
// Unlike the label channels there is no "empty = cleared" semantics — a presence
// item is always a positive assertion of a device's own liveness. Reducing
// defensively here keeps the function correct over any raw item list (full
// snapshot or otherwise), the same as reduceLabels.
export function reducePresence (items) {
    const newest = new Map()
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!isPresenceItem(item)) continue
        const id = typeof item.id === 'string' && item.id
            ? item.id
            : (typeof item.writerKey === 'string' && item.writerKey ? item.writerKey : null)
        if (!id) continue
        const at = numberOr(item.updatedAt, numberOr(item.lastActiveAt, 0))
        const prev = newest.get(id)
        if (prev && prev.updatedAt >= at) continue
        newest.set(id, {
            writerKey: id,
            lastActiveAt: numberOr(item.lastActiveAt, 0),
            lastInteractionAt: numberOr(item.lastInteractionAt, 0),
            sessionStartedAt: numberOr(item.sessionStartedAt, 0),
            cumulativeOnlineMs: Math.max(0, numberOr(item.cumulativeOnlineMs, 0)),
            sessionCount: Math.max(0, numberOr(item.sessionCount, 0)),
            updatedAt: at,
            attestedBy: typeof item.attestedBy === 'string' && item.attestedBy ? item.attestedBy : null,
            compaction: Math.max(0, numberOr(item.compaction, 0)),
        })
    }
    return newest
}

// True when a presence entry's last heartbeat is recent enough to count as online.
// `now` is the caller's wall-clock (ms); a UI passes Date.now() on each tick so
// online-now decays as time passes even with no new events.
export function isOnlineNow (entry, now, threshold = PRESENCE_ONLINE_THRESHOLD_MS) {
    if (!entry) return false
    const last = numberOr(entry.lastActiveAt, 0)
    if (last <= 0) return false
    return (now - last) < threshold
}

// The compaction wire version this build understands. Bumping it re-gates the
// owner's flatten action until every device advertises the new number.
export const COMPACTION_CAPABILITY = 1

// Can the owner safely flatten history for everybody yet?
//
// Compaction cannot fork a peer that ignores the barrier — it just reduces
// everything and arrives at the same state. But that only holds while the
// snapshot equals the reduction it replaces, so the owner is still making a
// mesh-wide call, and this turns that call into an OBSERVED fact.
//
// `presenceByWriter` is reducePresence()'s Map; `writerKeys` is the active writer
// set from the membership roster. A writer is ready only when it published its
// OWN heartbeat saying so: an owner-attested entry means that device never spoke
// for itself, so it can never be evidence about what it supports.
//
// `options.localWriterKey` is the ONE exception, and it is not a loosening of the
// rule — it is the rule applied honestly. The gate exists because a REMOTE
// device's capability cannot be assumed; the local one does not need to be
// assumed, because this function is running inside it. Without this, a host that
// does not publish presence at all can never satisfy its own gate: desktop sets
// `presenceWrites: false` (an Autobase append pending during boot replication
// would occupy the user write queue), so the owner's Flatten button sat
// permanently disabled, counting ITSELF as the device holding the mesh back.
export function compactionReadiness (presenceByWriter, writerKeys, options = {}) {
    const { required = COMPACTION_CAPABILITY, localWriterKey = null } = (
        typeof options === 'number' ? { required: options } : (options || {})
    )
    const local = typeof localWriterKey === 'string' && localWriterKey ? localWriterKey : null
    const keys = [...(writerKeys || [])].filter((key) => typeof key === 'string' && key)
    const blockers = []

    for (const writerKey of keys) {
        // Known, not observed: this build is the one being asked about.
        if (local && writerKey === local && COMPACTION_CAPABILITY >= required) continue
        const entry = presenceByWriter?.get?.(writerKey) || null
        if (!entry) {
            blockers.push({ writerKey, reason: 'no-presence' })
            continue
        }
        if (entry.attestedBy) {
            blockers.push({ writerKey, reason: 'attested' })
            continue
        }
        if (numberOr(entry.compaction, 0) < required) {
            blockers.push({ writerKey, reason: 'outdated' })
        }
    }

    return {
        // An empty writer set is not evidence of readiness.
        ready: keys.length > 0 && blockers.length === 0,
        total: keys.length,
        readyCount: keys.length - blockers.length,
        blockers,
    }
}

// Average online session length in ms (cumulativeOnlineMs / sessionCount). 0 when
// unknown (no completed/accounted sessions yet).
export function averageOnlineMs (entry) {
    if (!entry) return 0
    const total = Math.max(0, numberOr(entry?.cumulativeOnlineMs, 0))
    const count = Math.max(0, numberOr(entry?.sessionCount, 0))
    return count > 0 ? total / count : 0
}
