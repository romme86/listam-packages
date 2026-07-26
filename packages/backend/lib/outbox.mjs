// Durable queue for mutations the backend could not append.
//
// Listam is local-first, but until now a write it could not flush was simply
// refused and dropped: the user's edit disappeared. Desktop at least said so;
// mobile logged it. Neither kept the change.
//
// The queue holds a refused mutation until the writer can flush again, then
// replays it. That is the easy half. The hard half is that a queued operation is
// a change from the PAST being applied to a present the user has not seen, so
// replaying blindly is its own data-loss bug: if the encryption epoch rotated
// while the operation sat here, or the list was promoted to a different base,
// re-applying it can resurrect a deleted item or write into the wrong place.
//
// Every entry therefore records the world it was created in — its epoch and the
// base it targeted — and replay refuses when that world has moved on. Refusing
// is not failure: it escalates to the user, who is the only one who can say
// whether a stale edit is still wanted. Release 2 relaxes these preconditions
// once `apply` is deterministic and replay ordering is provable.
//
// Pure: no fs, no clock, no autobase. The caller supplies `now` and persists the
// serialized form. That keeps the ordering and precondition rules testable
// without spinning up a peer.

export const OUTBOX_VERSION = 1

// An entry stops being worth replaying eventually — a week-old "add milk" is
// noise, not intent.
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
// A runaway queue must not grow without bound; the oldest go first.
export const DEFAULT_MAX_ENTRIES = 500

/** Why an entry cannot be replayed automatically. */
export const BLOCKED_EPOCH_CHANGED = 'epoch-changed'
export const BLOCKED_BASE_CHANGED = 'base-changed'
export const BLOCKED_EXPIRED = 'expired'

function numberOr (value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeBaseKey (value) {
    if (typeof value !== 'string') return null
    const trimmed = value.trim().toLowerCase()
    return trimmed === '' ? null : trimmed
}

/**
 * Build an entry. `epoch` and `baseKey` capture the world the mutation was made
 * in; replay compares them against the world it would land in.
 */
export function createOutboxEntry ({ id, command, payload, listId = null, baseKey = null, epoch = null, now = 0 }) {
    if (typeof id !== 'string' || id === '') throw new Error('outbox entry requires an id')
    // A string tag ('ADD', 'UPDATE', ...) or an RPC command number — opaque to
    // this module; the replay driver is what knows how to perform it.
    if (!(typeof command === 'string' && command !== '') && !Number.isFinite(command)) {
        throw new Error('outbox entry requires a command')
    }
    return {
        id,
        command,
        payload: payload ?? null,
        listId: typeof listId === 'string' && listId ? listId : null,
        baseKey: normalizeBaseKey(baseKey),
        epoch: numberOr(epoch, null),
        createdAt: numberOr(now, 0),
        attempts: 0,
        lastAttemptAt: 0,
    }
}

/**
 * Add an entry, replacing any earlier one with the same id.
 *
 * De-duplicating by id is what makes the queue converge rather than accumulate:
 * a user editing the same row five times offline should replay ONE write with
 * their final text, not five. The reducer is LWW by id anyway, so the earlier
 * ones could only ever be overwritten — replaying them wastes appends and
 * momentarily shows stale text on peers.
 */
export function enqueue (entries, entry, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    const kept = (Array.isArray(entries) ? entries : []).filter((e) => e && e.id !== entry.id)
    kept.push(entry)
    // Oldest first when trimming: the newest edits are the ones still wanted.
    return kept.length > maxEntries ? kept.slice(kept.length - maxEntries) : kept
}

export function removeEntry (entries, id) {
    return (Array.isArray(entries) ? entries : []).filter((e) => e && e.id !== id)
}

/**
 * Can this entry be replayed into the CURRENT world?
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkPreconditions (entry, { epoch = null, baseKeyForList = undefined, now = 0, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    if (!entry) return { ok: false, reason: BLOCKED_EXPIRED }

    if (numberOr(now, 0) - numberOr(entry.createdAt, 0) > maxAgeMs) {
        return { ok: false, reason: BLOCKED_EXPIRED }
    }

    // An epoch rotation re-keys the list. An operation encrypted under the old
    // epoch cannot be read by peers, and re-encrypting it under the new one
    // silently republishes content the rotation may have been performed to
    // revoke access to. Neither is ours to decide.
    if (entry.epoch != null && epoch != null && entry.epoch !== epoch) {
        return { ok: false, reason: BLOCKED_EPOCH_CHANGED }
    }

    // The list moved base (shared, or un-shared) since the edit was made.
    // Replaying into the old base writes somewhere nobody is reading; replaying
    // into the new one applies an edit the user made against different content.
    // `undefined` means the caller does not know — treat as unchanged rather
    // than blocking every replay on a registry that has not loaded.
    if (baseKeyForList !== undefined && normalizeBaseKey(baseKeyForList) !== entry.baseKey) {
        return { ok: false, reason: BLOCKED_BASE_CHANGED }
    }

    return { ok: true }
}

/**
 * Split the queue into what may replay now and what cannot.
 *
 * Replayable entries come back in creation order: two offline edits to different
 * items must land in the order the user made them.
 *
 * @param {(entry: any) => (string|null|undefined)} resolveBaseKeyForList current
 *   base for an entry's list, or undefined when unknown.
 */
export function planReplay (entries, { epoch = null, resolveBaseKeyForList = () => undefined, now = 0, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    const ready = []
    const blocked = []
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry) continue
        const check = checkPreconditions(entry, {
            epoch,
            baseKeyForList: resolveBaseKeyForList(entry),
            now,
            maxAgeMs,
        })
        if (check.ok) ready.push(entry)
        else blocked.push({ entry, reason: check.reason })
    }
    ready.sort((a, b) => numberOr(a.createdAt, 0) - numberOr(b.createdAt, 0))
    return { ready, blocked }
}

/** Record an attempt, so a permanently failing entry is visible rather than silent. */
export function noteAttempt (entry, now = 0) {
    return { ...entry, attempts: numberOr(entry?.attempts, 0) + 1, lastAttemptAt: numberOr(now, 0) }
}

export function serialize (entries) {
    return JSON.stringify({ version: OUTBOX_VERSION, entries: Array.isArray(entries) ? entries : [] })
}

/**
 * Parse a persisted queue. Never throws and never returns partial garbage: a
 * corrupt outbox must not stop the backend from starting, and dropping a
 * malformed entry is better than replaying an unintelligible one.
 */
export function deserialize (raw) {
    if (typeof raw !== 'string' || raw === '') return []
    let parsed = null
    try {
        parsed = JSON.parse(raw)
    } catch {
        return []
    }
    if (!parsed || parsed.version !== OUTBOX_VERSION || !Array.isArray(parsed.entries)) return []
    return parsed.entries.filter((e) => e
        && typeof e.id === 'string' && e.id !== ''
        && ((typeof e.command === 'string' && e.command !== '') || Number.isFinite(e.command)))
}
