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
// Self-asserted: a device only ever writes its OWN key, so there is no contention;
// LWW by updatedAt (== lastActiveAt on a heartbeat). `attestedBy` is reserved for a
// future observer-attested variant (a writer hub publishing a blind/leaf peer's
// presence keyed by that peer's key); it is null on a normal self-published beat.

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
    }
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

// Average online session length in ms (cumulativeOnlineMs / sessionCount). 0 when
// unknown (no completed/accounted sessions yet).
export function averageOnlineMs (entry) {
    if (!entry) return 0
    const total = Math.max(0, numberOr(entry?.cumulativeOnlineMs, 0))
    const count = Math.max(0, numberOr(entry?.sessionCount, 0))
    return count > 0 ? total / count : 0
}
