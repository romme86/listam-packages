// Track queued work as well as running work. The sleep coordinator also drains
// Autobase through its public API; application counters alone cannot prove idle.
export function createBackendActivity() {
    let pending = 0, revision = 0
    const listeners = new Set()
    function begin() {
        pending++
        revision++
        let ended = false
        return () => {
            if (ended) return
            ended = true
            pending--
            revision++
            if (!pending) for (const listener of [...listeners]) listener()
        }
    }
    async function track(run) {
        const done = begin()
        try { return await run() } finally { done() }
    }
    function waitForIdle(deadline) {
        if (!pending) return Promise.resolve(true)
        return new Promise((resolve) => {
            const finish = (idle) => { clearTimeout(timer); listeners.delete(onIdle); resolve(idle) }
            const onIdle = () => finish(true)
            const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()))
            listeners.add(onIdle)
        })
    }
    return { begin, track, waitForIdle, snapshot: () => ({ pending, revision }) }
}

export const backendActivity = createBackendActivity()
