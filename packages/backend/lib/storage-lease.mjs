// Storage lease for single-writer access to a backend storage root.
//
// Replaces the bare `open(path, 'wx')` lock, which had two failure modes the
// multi-app plan calls out: a hard crash left a stale lock file that blocked
// every later start until the user deleted it by hand, and the file carried
// no owner/lease metadata so a second process (desktop + headless on one
// machine) could not tell a live owner from a dead one.
//
// The lease is a JSON document with an owner instance id, role, and an
// expiry that the owner renews on a heartbeat. Acquisition still uses an
// exclusive create for the common path; when the file already exists, the
// lease is read and taken over only if it is expired or unreadable. A live,
// unexpired lease held by another instance always wins.
//
// Takeover (remove + exclusive recreate) is not atomic across processes; two
// starters racing over the same expired lease can interleave. The post-write
// verification in renew() detects the loser, which stops heartbeating and
// reports the lease as lost. That is the honest scope of a file-based lease.

const DEFAULT_TTL_MS = 30_000
const ACQUIRE_ATTEMPTS = 3

export function createStorageLease({ fs, path, instanceId, role = 'backend', ttlMs = DEFAULT_TTL_MS, now = Date.now }) {
    if (!fs) throw new Error('A filesystem adapter is required for the storage lease')
    if (!path) throw new Error('A lease path is required')
    if (!instanceId) throw new Error('A lease instance id is required')

    let held = false
    let acquiredAt = null
    let heartbeatTimer = null

    function readLease() {
        try {
            const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
            return parsed && typeof parsed === 'object' ? parsed : null
        } catch {
            return null
        }
    }

    function isLive(lease) {
        return !!lease && typeof lease.expiresAt === 'number' && lease.expiresAt > now()
    }

    function leaseDocument() {
        const time = now()
        return {
            version: 1,
            instanceId,
            role,
            acquiredAt: acquiredAt ?? time,
            renewedAt: time,
            expiresAt: time + ttlMs,
        }
    }

    function writeExclusive(doc) {
        const fd = fs.openSync(path, 'wx')
        try {
            fs.writeSync(fd, JSON.stringify(doc))
        } finally {
            fs.closeSync(fd)
        }
    }

    function acquire() {
        let recoveredStale = false

        for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
            acquiredAt = now()
            try {
                writeExclusive(leaseDocument())
                held = true
                return { ok: true, recoveredStale }
            } catch {
                acquiredAt = null
            }

            const existing = readLease()
            if (isLive(existing) && existing.instanceId !== instanceId) {
                return {
                    ok: false,
                    reason: 'held',
                    owner: {
                        instanceId: existing.instanceId,
                        role: existing.role,
                        expiresAt: existing.expiresAt,
                    },
                }
            }

            // Expired, unreadable, or our own leftover lease: recover it.
            recoveredStale = true
            try {
                fs.rmSync(path, { force: true })
            } catch {}
        }

        return { ok: false, reason: 'contention' }
    }

    // Re-assert ownership and extend the expiry. Returns false (and drops the
    // lease) when another instance has taken the file over.
    function renew() {
        if (!held) return false

        const current = readLease()
        if (current && current.instanceId !== instanceId) {
            held = false
            return false
        }

        try {
            fs.writeFileSync(path, JSON.stringify(leaseDocument()))
        } catch {
            return false
        }
        return true
    }

    function startHeartbeat(onLost) {
        stopHeartbeat()
        const interval = Math.max(1000, Math.floor(ttlMs / 3))
        heartbeatTimer = setInterval(() => {
            if (!renew()) {
                stopHeartbeat()
                onLost?.()
            }
        }, interval)
        heartbeatTimer?.unref?.()
        return heartbeatTimer
    }

    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
        }
    }

    function release() {
        stopHeartbeat()
        if (!held) return

        const current = readLease()
        if (!current || current.instanceId === instanceId) {
            try {
                fs.rmSync(path, { force: true })
            } catch {}
        }
        held = false
        acquiredAt = null
    }

    return {
        acquire,
        renew,
        release,
        startHeartbeat,
        stopHeartbeat,
        describeOwner: readLease,
        isHeld: () => held,
    }
}
