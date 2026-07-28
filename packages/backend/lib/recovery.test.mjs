import test from 'node:test'
import assert from 'node:assert/strict'
import {
    describeCorruption,
    isCorruptionSignature,
    normalizeRecoveryPolicy,
    planRecoveryAction,
    quarantineStorageRoot,
} from './recovery.mjs'

function createFakeFs(initialPaths = []) {
    const paths = new Set(initialPaths)
    const writes = new Map()
    return {
        paths,
        writes,
        existsSync(path) {
            return paths.has(path)
        },
        renameSync(from, to) {
            if (!paths.has(from)) throw new Error('ENOENT')
            paths.delete(from)
            paths.add(to)
        },
        writeFileSync(path, data) {
            writes.set(path, String(data))
        },
    }
}

test('corruption detection matches the known autobase boot signatures only', () => {
    assert.equal(isCorruptionSignature(new TypeError("Cannot read properties of undefined (reading 'signers')")), true)
    assert.equal(isCorruptionSignature({ stack: 'at boot (/x/node_modules/autobase/lib/store.js:10:3)' }), true)
    assert.equal(isCorruptionSignature(new Error('connection reset by peer')), false)
    assert.equal(isCorruptionSignature(null), false)

    assert.equal(describeCorruption(new Error("reading 'signers'")).signature, 'autobase-boot')
    assert.equal(describeCorruption(new Error('disk on fire')).signature, 'unknown')
})

test('a corrupt state never plans silent deletion: reset requires pending corruption AND an interactive policy', () => {
    const pending = { reason: 'storage-corrupt' }

    // Retry is the universally safe action.
    assert.equal(planRecoveryAction({ action: 'retry', policy: 'interactive', pending }).ok, true)
    assert.equal(planRecoveryAction({ action: 'retry', policy: 'refuse-destructive', pending }).ok, true)

    // Headless nodes refuse the destructive path outright (M4 acceptance).
    const refused = planRecoveryAction({ action: 'reset', policy: 'refuse-destructive', pending })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'destructive-recovery-refused')

    // An unknown policy fails safe to refuse-destructive.
    assert.equal(normalizeRecoveryPolicy('yolo'), 'refuse-destructive')
    assert.equal(planRecoveryAction({ action: 'reset', policy: 'yolo', pending }).ok, false)

    // Interactive + pending + explicit reset is the only destructive plan.
    assert.equal(planRecoveryAction({ action: 'reset', policy: 'interactive', pending }).ok, true)
})

test('recovery actions are rejected when no corruption is pending (a stray reset cannot wipe a healthy base)', () => {
    const result = planRecoveryAction({ action: 'reset', policy: 'interactive', pending: null })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no-recovery-pending')

    const unknown = planRecoveryAction({ action: 'wipe-everything', policy: 'interactive', pending: { reason: 'x' } })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.reason, 'unknown-action')
})

test('quarantine moves the storage root aside intact and never deletes it', () => {
    const fs = createFakeFs(['/data/lista-local'])
    const result = quarantineStorageRoot(fs, '/data/lista-local', {
        reason: 'storage-corrupt',
        fingerprints: { baseKey: 'fp-abc123', encryptionKey: 'fp-def456' },
        now: () => Date.parse('2026-06-10T12:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.match(result.quarantinePath, /^\/data\/lista-local\.quarantine-2026-06-10T12-00-00-000Z$/)
    assert.equal(fs.paths.has('/data/lista-local'), false, 'original root was renamed, not deleted')
    assert.equal(fs.paths.has(result.quarantinePath), true)

    const manifest = JSON.parse(fs.writes.get(`${result.quarantinePath}/RECOVERY.json`))
    assert.equal(manifest.reason, 'storage-corrupt')
    assert.equal(manifest.fingerprints.baseKey, 'fp-abc123')
})

test('the quarantine manifest carries fingerprints only, never raw key material', () => {
    const rawKeyHex = 'a'.repeat(64)
    const fs = createFakeFs(['/data/lista-local'])
    const result = quarantineStorageRoot(fs, '/data/lista-local', {
        fingerprints: { baseKey: 'fp-abc123' },
        now: () => 1_750_000_000_000,
    })

    const manifest = fs.writes.get(`${result.quarantinePath}/RECOVERY.json`)
    assert.equal(manifest.includes(rawKeyHex), false)
    assert.equal(/[0-9a-f]{64}/.test(manifest), false, 'no 32-byte hex blob may appear in the manifest')
})

test('quarantine picks a fresh archive name when one already exists for the same instant', () => {
    const stampedAt = Date.parse('2026-06-10T12:00:00.000Z')
    const existing = '/data/lista-local.quarantine-2026-06-10T12-00-00-000Z'
    const fs = createFakeFs(['/data/lista-local', existing])

    const result = quarantineStorageRoot(fs, '/data/lista-local', { now: () => stampedAt })
    assert.equal(result.ok, true)
    assert.equal(result.quarantinePath, `${existing}-1`)
    assert.equal(fs.paths.has(existing), true, 'the prior archive is untouched')
})

test('quarantining a missing root reports missing without side effects', () => {
    const fs = createFakeFs()
    const result = quarantineStorageRoot(fs, '/data/lista-local')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'missing')
    assert.equal(fs.writes.size, 0)
})
