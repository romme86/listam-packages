// One budget covers sockets, application queues and the databases. A deadline
// bounds this handshake without pretending to cancel native I/O. Safe-to-sleep
// describes local work at the handshake, not delivery to every remote peer.
export function createSleepCoordinator({ activity, suspendNetwork, resumeNetwork, networkSnapshot, getBases, timeoutMs = 8000 }) {
    let generation = 0
    let last = { safeToSleep: false, reason: 'active' }
    let drainedRevision = -1
    let sleeping = null

    async function suspend() {
        if (sleeping) return sleeping
        const mine = ++generation
        const deadline = Date.now() + timeoutMs
        let timer
        const drain = async () => {
            if (!await suspendNetwork()) return { safeToSleep: false, reason: 'network-unavailable' }
            while (mine === generation && Date.now() < deadline) {
                if (!await activity.waitForIdle(deadline)) break
                const before = activity.snapshot()
                const bases = [...new Set(getBases())].filter(Boolean)
                // Start all bases together: one unavailable writer must not
                // prevent another base from draining within the same budget.
                await Promise.all(bases.map(async (base) => {
                    if (base.closing) return
                    await base.advance()
                    await base.flush()
                }))
                if (mine !== generation || Date.now() >= deadline) break
                const after = activity.snapshot()
                const current = [...new Set(getBases())].filter(Boolean)
                if (before.revision !== after.revision || after.pending || current.some((base) => !bases.includes(base))) continue
                const net = networkSnapshot()
                if (!net.desiredSuspended) return { safeToSleep: false, reason: 'superseded' }
                if (!net.allSuspended) {
                    if (!await suspendNetwork()) break
                    continue
                }
                return { safeToSleep: mine === generation, reason: mine === generation ? 'drained' : 'superseded', revision: after.revision }
            }
            return { safeToSleep: false, reason: mine === generation ? 'deadline' : 'superseded' }
        }
        const result = Promise.race([
            drain().catch(() => ({ safeToSleep: false, reason: 'drain-failed' })),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ safeToSleep: false, reason: 'deadline' }), timeoutMs) }),
        ]).then((status) => {
            // A late suspend reply must never overwrite a newer foreground.
            const now = activity.snapshot()
            const net = networkSnapshot()
            const value = mine !== generation
                ? { safeToSleep: false, reason: 'superseded' }
                : status.safeToSleep && (now.pending || now.revision !== status.revision || !net.allSuspended || !net.desiredSuspended)
                    ? { safeToSleep: false, reason: 'busy' }
                    : { safeToSleep: status.safeToSleep, reason: status.reason }
            if (mine === generation) {
                last = value
                drainedRevision = value.safeToSleep ? now.revision : -1
            }
            return { ...value, suspended: net.allSuspended }
        }).finally(() => {
            clearTimeout(timer)
            if (sleeping === result) sleeping = null
        })
        sleeping = result
        return result
    }

    async function resume() {
        ++generation
        sleeping = null
        last = { safeToSleep: false, reason: 'active' }
        return resumeNetwork()
    }
    function snapshot() {
        const current = activity.snapshot(), net = networkSnapshot()
        const safeToSleep = last.safeToSleep && current.pending === 0 && current.revision === drainedRevision && net.desiredSuspended && net.allSuspended
        return { ...last, ...current, safeToSleep, reason: last.safeToSleep && !safeToSleep ? 'busy' : last.reason }
    }
    return { suspend, resume, snapshot }
}
