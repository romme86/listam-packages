// Owns the set of SHARED single-list bases open alongside the personal base.
//
// The personal base's registry is the index of "which shared bases this device
// should be in": every list meta-item with a `regBaseKey` (see list-registry)
// names a shared base. The manager diffs that desired set against what's open and
// opens/closes to converge — this is what makes shared lists auto-join across the
// owner's devices (a paired device syncs the registry, then reconcile() joins the
// referenced bases) and auto-open on launch.
//
// The actual open/close lifecycle (Corestore/Autobase/Hyperswarm per base) is
// injected as `openShared(baseKey)` / `closeShared(baseKey)` so this module stays
// pure and unit-testable. Shared bases are keyed by their base key (hex).

// Pure: the set of shared base keys a reduced registry says we should be in.
export function desiredSharedBaseKeys (registry) {
    const lists = registry && Array.isArray(registry.lists) ? registry.lists : []
    const keys = new Set()
    for (const l of lists) {
        if (l && typeof l.baseKey === 'string' && l.baseKey) keys.add(l.baseKey)
    }
    return keys
}

// Above this many concurrently open shared bases, the per-base swarm topology
// starts to cost something worth revisiting. Measured 2026-07-28 while spiking
// swarm multiplexing (Release 3.2):
//
//   - An idle Hyperswarm is CHEAP in memory: ~0.15 MB RSS and zero extra process
//     handles each, at 1/4/8 instances. Memory is not the reason to multiplex.
//   - The real cost is identity. Each Hyperswarm mints its OWN keypair
//     (hyperswarm/index.js: `keyPair = DHT.keyPair(seed)`) and dedupes
//     connections per remote key in a PER-INSTANCE set (`_allConnections`). So N
//     open shared bases present N identities to the same remote device and hold N
//     connections to it — N Noise handshakes, N keepalives, N independent DHT
//     announce/lookup cycles. On mobile that is N times the radio wakeups.
//   - Multiplexing (one swarm, N topics, replication muxed over one connection
//     per peer) collapses that to 1 — but it rewires the most fragile subsystem
//     in the app, the one with a documented history of join wedges and
//     discovery bugs.
//
// The spike did NOT adopt it, because the premise was absent: the live mesh had
// ZERO shared bases open on every peer checked, so every device already runs
// exactly one swarm and multiplexing would collapse 1 into 1. This warning is
// what makes that decision revisitable automatically instead of by memory.
export const SHARED_BASE_SWARM_ADVISORY = 4

export function createBaseManager ({ openShared, closeShared, logger = null } = {}) {
    const shared = new Map() // baseKeyHex -> BaseContext
    let advised = false

    async function reconcile (registry) {
        const desired = desiredSharedBaseKeys(registry)
        const open = new Set(shared.keys())
        const opened = []
        const closed = []
        // Open any desired base not yet open.
        for (const key of desired) {
            if (!shared.has(key)) {
                const ctx = openShared ? await openShared(key) : null
                if (ctx) { shared.set(key, ctx); opened.push(key) }
            }
        }
        // Close any open base no longer referenced by the registry.
        for (const key of open) {
            if (!desired.has(key)) {
                if (closeShared) await closeShared(key, shared.get(key))
                shared.delete(key)
                closed.push(key)
            }
        }
        // One-shot: the point is to notice the threshold being crossed, not to
        // log on every reconcile thereafter.
        if (!advised && shared.size > SHARED_BASE_SWARM_ADVISORY) {
            advised = true
            logger?.log?.('[WARNING] Many shared bases open; each runs its own swarm and holds a separate connection to every peer. Revisit swarm multiplexing (Release 3.2).', {
                openSharedBases: shared.size,
                advisory: SHARED_BASE_SWARM_ADVISORY,
            })
        }

        return { opened, closed }
    }

    return {
        shared,
        has: (baseKey) => shared.has(baseKey),
        get: (baseKey) => shared.get(baseKey) ?? null,
        list: () => [...shared.values()],
        keys: () => [...shared.keys()],
        register: (baseKey, ctx) => { if (baseKey) shared.set(baseKey, ctx); return ctx },
        remove: (baseKey) => shared.delete(baseKey),
        reconcile,
    }
}
