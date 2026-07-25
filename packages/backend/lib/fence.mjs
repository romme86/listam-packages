// A one-way "this process must not write any more" latch.
//
// The storage lease is what makes one Corestore root safe to open: exactly one
// live instance owns it, renewing on a heartbeat. Takeover of an EXPIRED lease
// is deliberately not atomic across processes (see storage-lease.mjs), so two
// starters racing can interleave — the loser detects it on its next renew and
// reports the lease lost.
//
// Reporting is not enough. Until this module existed the loss callback only
// logged, and the losing backend carried on appending to a Corestore another
// process now owned. Two writers on one storage root is the failure mode the
// lease exists to prevent, so the loser has to stop: fence() latches, every
// write path checks isFenced() first, and the host tears the instance down.
//
// One-way on purpose. A fenced backend never un-fences — recovery means a fresh
// process that acquires the lease cleanly. clearFence() exists only so tests and
// startBackend() can reset module state between instances in one process.

let fenced = null

/**
 * Latch this process out of all writes. Idempotent: the FIRST reason wins, so a
 * cascade of follow-on failures cannot overwrite the true cause.
 * @param {string} reason machine-readable cause, e.g. 'storage-lease-lost'
 * @param {number} at epoch ms
 */
export function fence (reason, at = Date.now()) {
    if (!fenced) fenced = { reason: String(reason || 'unknown'), at }
    return fenced
}

export function isFenced () {
    return fenced !== null
}

export function fenceState () {
    return fenced
}

export function fenceReason () {
    return fenced?.reason ?? null
}

// Test/reinit hook only. Production code must never call this to "recover".
export function clearFence () {
    fenced = null
}
