import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setBackendFs } from './platform-fs.mjs'
import { decryptBackup } from './backup-crypto.mjs'
import {
    __setAutoBackupDirForTests,
    isBackupPasswordSet,
    setBackupPassword,
    writeAutoBackup,
    listAutoBackups,
    createAutoBackup,
} from './auto-backup.mjs'

setBackendFs(fs)

// Fresh, isolated backup dir per test so module state can't leak between them.
function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listam-ab-'))
    __setAutoBackupDirForTests(dir)
    return dir
}

const deviceHex = (dir) => fs.readFileSync(path.join(dir, 'device.key'), 'utf8').trim()
const combined = (dir, pw) => `${pw}::${deviceHex(dir)}`
const SNAP = { snapshotVersion: 1, items: [{ id: 'a', text: 'Milk' }], boardConfig: null }

test('no password set: not set, and createAutoBackup skips without writing', async () => {
    freshDir()
    assert.equal(isBackupPasswordSet(), false)
    const r = await createAutoBackup({ reason: 'pre-join' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-password')
    assert.equal(listAutoBackups().length, 0)
})

test('setBackupPassword enables backups; written file decrypts only with device key + password', async () => {
    const dir = freshDir()
    await setBackupPassword({ next: 'password1' })
    assert.equal(isBackupPasswordSet(), true)

    const { ok, file } = writeAutoBackup(SNAP, { reason: 'pre-join', createdAt: 1000 })
    assert.equal(ok, true)
    const env = fs.readFileSync(path.join(dir, file), 'utf8')

    // Right combined secret round-trips the snapshot.
    assert.deepEqual(decryptBackup(env, combined(dir, 'password1')).payload, SNAP)
    // Wrong password fails even with the right device key.
    assert.throws(() => decryptBackup(env, combined(dir, 'wrongpass')))
    // The password alone (no device key) fails too.
    assert.throws(() => decryptBackup(env, 'password1'))
})

test('retention caps the number of kept backups', async () => {
    freshDir()
    await setBackupPassword({ next: 'password1' })
    for (let i = 0; i < 23; i++) writeAutoBackup(SNAP, { reason: 'pre-join', createdAt: 1000 + i })
    const kept = listAutoBackups()
    assert.equal(kept.length, 20)
    // The newest are kept (sorted desc), oldest pruned.
    assert.equal(kept[0].createdAt, 1022)
    assert.equal(kept.at(-1).createdAt, 1003)
})

test('changing the password re-encrypts existing backups and rejects a wrong current', async () => {
    const dir = freshDir()
    await setBackupPassword({ next: 'password1' })
    const { file } = writeAutoBackup(SNAP, { reason: 'pre-join', createdAt: 2000 })

    await assert.rejects(setBackupPassword({ current: 'nope', next: 'password2' }), /Wrong password/)

    await setBackupPassword({ current: 'password1', next: 'password2' })
    const env = fs.readFileSync(path.join(dir, file), 'utf8')
    assert.deepEqual(decryptBackup(env, combined(dir, 'password2')).payload, SNAP)
    assert.throws(() => decryptBackup(env, combined(dir, 'password1')))
})

test('a short password is rejected', async () => {
    freshDir()
    await assert.rejects(setBackupPassword({ next: 'short' }), /password-too-short/)
    assert.equal(isBackupPasswordSet(), false)
})

test('the device secret is stable across calls (older backups stay openable)', async () => {
    const dir = freshDir()
    await setBackupPassword({ next: 'password1' })
    const a = writeAutoBackup(SNAP, { reason: 'pre-join', createdAt: 3000 })
    const hex1 = deviceHex(dir)
    writeAutoBackup(SNAP, { reason: 'pre-join', createdAt: 3001 })
    const hex2 = deviceHex(dir)
    assert.equal(hex1, hex2)
    // The first file still opens with the (unchanged) combined secret.
    const env = fs.readFileSync(path.join(dir, a.file), 'utf8')
    assert.deepEqual(decryptBackup(env, combined(dir, 'password1')).payload, SNAP)
})
