import test from 'node:test'
import assert from 'node:assert/strict'
import { createStorageLease } from './storage-lease.mjs'

const LEASE_PATH = '/data/lista.lock'

// Minimal fs fake with the exclusive-create semantics the lease relies on.
function createFakeFs(initialFiles = {}) {
    const files = new Map(Object.entries(initialFiles))
    let nextFd = 1
    const open = new Map()

    return {
        files,
        openSync(path, flags) {
            if (flags === 'wx' && files.has(path)) {
                const err = new Error(`EEXIST: file already exists, open '${path}'`)
                err.code = 'EEXIST'
                throw err
            }
            const fd = nextFd++
            open.set(fd, path)
            files.set(path, '')
            return fd
        },
        writeSync(fd, data) {
            const path = open.get(fd)
            if (!path) throw new Error('EBADF')
            files.set(path, String(data))
        },
        closeSync(fd) {
            open.delete(fd)
        },
        readFileSync(path) {
            if (!files.has(path)) {
                const err = new Error(`ENOENT: no such file, open '${path}'`)
                err.code = 'ENOENT'
                throw err
            }
            return files.get(path)
        },
        writeFileSync(path, data) {
            files.set(path, String(data))
        },
        rmSync(path) {
            files.delete(path)
        },
        existsSync(path) {
            return files.has(path)
        },
    }
}

function leaseAt(fs, instanceId, { now, ttlMs = 30_000, role } = {}) {
    return createStorageLease({ fs, path: LEASE_PATH, instanceId, role, ttlMs, now })
}

test('a fresh lease is acquired and carries owner, role, and expiry metadata', () => {
    const fs = createFakeFs()
    let time = 1_000
    const lease = leaseAt(fs, 'instance-a', { now: () => time, role: 'mobile' })

    const result = lease.acquire()
    assert.equal(result.ok, true)
    assert.equal(result.recoveredStale, false)
    assert.equal(lease.isHeld(), true)

    const doc = JSON.parse(fs.files.get(LEASE_PATH))
    assert.equal(doc.instanceId, 'instance-a')
    assert.equal(doc.role, 'mobile')
    assert.equal(doc.acquiredAt, 1_000)
    assert.equal(doc.expiresAt, 31_000)
})

test('a live lease held by another instance refuses acquisition and names the owner', () => {
    const fs = createFakeFs()
    let time = 1_000
    const first = leaseAt(fs, 'instance-a', { now: () => time })
    assert.equal(first.acquire().ok, true)

    time = 10_000 // within the 30s TTL
    const second = leaseAt(fs, 'instance-b', { now: () => time })
    const result = second.acquire()

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'held')
    assert.equal(result.owner.instanceId, 'instance-a')
    assert.equal(second.isHeld(), false)
    // The losing instance must not have clobbered the live lease.
    assert.equal(JSON.parse(fs.files.get(LEASE_PATH)).instanceId, 'instance-a')
})

test('an expired lease is recovered instead of blocking startup forever', () => {
    const fs = createFakeFs()
    let time = 1_000
    const crashed = leaseAt(fs, 'instance-a', { now: () => time })
    assert.equal(crashed.acquire().ok, true)
    // instance-a crashes without release(); its lease expires at 31_000.

    time = 60_000
    const next = leaseAt(fs, 'instance-b', { now: () => time })
    const result = next.acquire()

    assert.equal(result.ok, true)
    assert.equal(result.recoveredStale, true)
    assert.equal(JSON.parse(fs.files.get(LEASE_PATH)).instanceId, 'instance-b')
})

test('an unreadable lease file is treated as stale and recovered', () => {
    const fs = createFakeFs({ [LEASE_PATH]: 'not-json{{{' })
    const lease = leaseAt(fs, 'instance-a', { now: () => 1_000 })

    const result = lease.acquire()
    assert.equal(result.ok, true)
    assert.equal(result.recoveredStale, true)
    assert.equal(JSON.parse(fs.files.get(LEASE_PATH)).instanceId, 'instance-a')
})

test('renew extends the expiry while preserving the original acquisition time', () => {
    const fs = createFakeFs()
    let time = 1_000
    const lease = leaseAt(fs, 'instance-a', { now: () => time })
    assert.equal(lease.acquire().ok, true)

    time = 20_000
    assert.equal(lease.renew(), true)

    const doc = JSON.parse(fs.files.get(LEASE_PATH))
    assert.equal(doc.acquiredAt, 1_000)
    assert.equal(doc.renewedAt, 20_000)
    assert.equal(doc.expiresAt, 50_000)
})

test('renew reports a lease lost to another instance instead of overwriting it', () => {
    const fs = createFakeFs()
    let time = 1_000
    const original = leaseAt(fs, 'instance-a', { now: () => time })
    assert.equal(original.acquire().ok, true)

    // Another instance recovers the lease after expiry while we were asleep.
    time = 60_000
    const usurper = leaseAt(fs, 'instance-b', { now: () => time })
    assert.equal(usurper.acquire().ok, true)

    assert.equal(original.renew(), false)
    assert.equal(original.isHeld(), false)
    assert.equal(JSON.parse(fs.files.get(LEASE_PATH)).instanceId, 'instance-b')
})

test('release removes our own lease but never someone else\'s', () => {
    const fs = createFakeFs()
    let time = 1_000
    const original = leaseAt(fs, 'instance-a', { now: () => time })
    assert.equal(original.acquire().ok, true)

    time = 60_000
    const usurper = leaseAt(fs, 'instance-b', { now: () => time })
    assert.equal(usurper.acquire().ok, true)

    original.release()
    assert.equal(fs.files.has(LEASE_PATH), true, 'the usurper lease must survive a stale release')
    assert.equal(JSON.parse(fs.files.get(LEASE_PATH)).instanceId, 'instance-b')

    usurper.release()
    assert.equal(fs.files.has(LEASE_PATH), false)
})
