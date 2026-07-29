// The join watch's give-up rule.
//
// Joining is not a bounded operation. A guest has to replay the whole history of
// the base it just paired with before Autobase settles and `writable` can flip,
// and that replay scales with the project, not with the network: a phone joining
// a base that had rotated through seven epochs ground for ~5 minutes at full CPU
// (2026-07-29), because every op predating the single epoch key the invite
// carries fails to decrypt — one AEAD attempt per held key — before being
// skipped.
//
// A fixed wall-clock cap therefore reports failure while the backend is still
// working correctly. That is what it did: the UI showed "Timed out waiting for
// write access from host" at 120s, and the join completed minutes later.
//
// So the rule is "no forward progress for this long", not "not finished by this
// time". The linearized view length is the progress signal — it advances
// throughout the replay, long before writability — and it is monotonic per
// attempt, so a stale or shrinking read (Autobase truncates the view on a
// reorg) is never mistaken for progress.

export function createJoinProgressDeadline({ timeoutMs, now = Date.now() } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('createJoinProgressDeadline requires a positive timeoutMs')
    }

    let deadline = now + timeoutMs
    let highWaterMark = -1

    return {
        // Explicit progress that is not a view advance — e.g. writability
        // flipped and the watch moved on to waiting for the main swarm.
        noteProgress(at = Date.now()) {
            deadline = at + timeoutMs
        },

        // Returns whether this observation counted as progress, so the caller
        // can log the transition without tracking the mark itself.
        observeViewLength(length, at = Date.now()) {
            const value = Number(length)
            if (!Number.isFinite(value) || value <= highWaterMark) return false
            highWaterMark = value
            deadline = at + timeoutMs
            return true
        },

        expired(at = Date.now()) {
            return at >= deadline
        },

        deadlineAt() {
            return deadline
        },
    }
}
