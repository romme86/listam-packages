import { createJoinProgressDeadline } from './join-progress.mjs'

// Observe progress independently of update()/view reads: either can wait on a
// missing peer block forever. Awaiting them in the timer disables the deadline.
export function createJoinWatch({
    base,
    swarm,
    isCurrent,
    onCheck,
    onTimeout,
    onHeartbeat = () => {},
    timeoutMs,
    pollMs = 5000,
    heartbeatMs = 10000,
    startedAt = Date.now(),
}) {
    const progress = createJoinProgressDeadline({ timeoutMs })
    let lastHeartbeat = Date.now()
    let stopped = false
    let timer = null

    function stop() {
        if (stopped) return
        stopped = true
        clearTimeout(timer)
        base?.removeListener('update', check)
        swarm?.removeListener('connection', check)
    }

    function check() {
        if (stopped) return
        if (!isCurrent()) return stop()
        progress.observeViewLength(base?.view?.length ?? 0)
        onCheck(progress)
        if (stopped) return
        if (!isCurrent()) return stop()
        if (progress.expired()) {
            stop()
            onTimeout()
            return
        }
        const now = Date.now()
        if (now - lastHeartbeat >= heartbeatMs) {
            lastHeartbeat = now
            onHeartbeat(now - startedAt)
        }
    }

    function tick() {
        check()
        if (!stopped) timer = setTimeout(tick, pollMs)
    }

    base?.on('update', check)
    swarm?.on('connection', check)
    timer = setTimeout(tick, pollMs)
    // The caller installs stop before checking; an already-writable base may
    // finish synchronously and must be able to detach its watch immediately.
    return { check, stop }
}
