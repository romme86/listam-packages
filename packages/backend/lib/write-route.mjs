// Pure routing decisions and a bounded wait used by the mutation handler.
// Kept separate so stale-route and timeout behavior can be regression-tested
// without booting a full backend.

export function writeRouteAfterReconcile ({ mappedBefore = null, requestedKey = null, mappedAfter = null } = {}) {
    // A route that existed before reconciliation but disappeared means the
    // registry now owns this list on the personal base (for example orphan
    // healing). Reusing requestedKey would resurrect the stale shared route.
    if (mappedBefore && !mappedAfter) return { personal: true, key: null }
    return { personal: false, key: mappedAfter || requestedKey || null }
}

export async function settlesWithin (promise, timeoutMs) {
    let timer = null
    try {
        return await Promise.race([
            Promise.resolve(promise).then(() => true, () => true),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
