// Serialize native transitions per swarm. A rapid background/foreground pair
// must finish suspending before rebinding sockets. All bases advance together;
// one unavailable peer cannot delay the other bases or the lifecycle RPC.
export function createSwarmLifecycle({ getSwarms, timeoutMs = 8000, onError = () => {} }) {
    const states = new WeakMap()
    const registered = new Set()
    let desiredSuspended = false

    function allSwarms() {
        for (const s of registered) if (s.destroyed) registered.delete(s)
        return [...new Set([...registered, ...getSwarms()])].filter((s) => s && !s.destroyed)
    }

    function transition(swarm, suspended) {
        let state = states.get(swarm)
        if (!state) { state = { desired: suspended, running: Promise.resolve(), pending: 0 }; states.set(swarm, state) }
        state.desired = suspended
        state.pending++
        // Always enqueue the reconciliation itself. A request arriving between
        // the previous loop ending and its finalizer must not lose its intent.
        state.running = state.running.catch(() => false).then(async () => {
                while (!swarm.destroyed && swarm.suspended !== state.desired) {
                    const target = state.desired
                    try {
                        if (target) await swarm.suspend()
                        else await swarm.resume()
                    } catch (error) {
                        try { onError(error) } catch { /* logging cannot poison the queue */ }
                        return false
                    }
                    // Do not spin if an adapter did not change its state.
                    if (swarm.suspended !== target) return false
                }
                return !swarm.destroyed
            }).finally(() => { state.pending-- })
        return state.running
    }

    function register(swarm) {
        if (!swarm || swarm.destroyed || registered.has(swarm)) return
        registered.add(swarm)
        swarm.once?.('close', () => registered.delete(swarm))
        void transition(swarm, desiredSuspended)
    }

    function snapshot() {
        const swarms = allSwarms()
        return {
            desiredSuspended,
            swarms: swarms.length,
            transitioning: swarms.filter((s) => states.get(s)?.pending > 0).length,
            allSuspended: swarms.every((s) => s.suspended && !(states.get(s)?.pending > 0)),
        }
    }

    async function setSuspended(suspended) {
        desiredSuspended = suspended
        const swarms = allSwarms()
        if (!swarms.length) return false
        let timer
        try {
            return await Promise.race([
                (async () => {
                    let work = swarms.map((s) => transition(s, suspended))
                    while (work.length) {
                        const results = await Promise.all(work)
                        if (desiredSuspended !== suspended || !results.every(Boolean)) return false
                        work = allSwarms()
                            .filter((s) => s.suspended !== suspended || states.get(s)?.pending > 0)
                            .map((s) => states.get(s)?.pending > 0 ? states.get(s).running : transition(s, suspended))
                    }
                    return true
                })(),
                new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
            ])
        } finally {
            clearTimeout(timer)
        }
        // A timeout bounds the caller, not the native operation. Its per-swarm
        // queue remains alive and applies the latest intent when it settles.
    }

    return { register, snapshot, suspend: () => setSuspended(true), resume: () => setSuspended(false) }
}
