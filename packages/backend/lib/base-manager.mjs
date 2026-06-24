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

export function createBaseManager ({ openShared, closeShared } = {}) {
    const shared = new Map() // baseKeyHex -> BaseContext

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
