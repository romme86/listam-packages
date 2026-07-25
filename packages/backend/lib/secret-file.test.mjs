import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECRET_DIR_MODE, SECRET_FILE_MODE, hardenSecretDir, tightenSecretFile, writeSecretFileAtomic } from './secret-file.mjs'

function tmpDir (t) {
    const dir = mkdtempSync(join(tmpdir(), 'listam-secret-file-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    return dir
}

const modeOf = (path) => statSync(path).mode & 0o777

test('a secret is written owner-only, whatever the umask', (t) => {
    const dir = tmpDir(t)
    const path = join(dir, 'epoch.key')
    assert.equal(writeSecretFileAtomic(fs, path, 'deadbeef'), true)
    assert.equal(fs.readFileSync(path, 'utf8'), 'deadbeef')
    assert.equal(modeOf(path), SECRET_FILE_MODE, 'a key file must not be group/world readable')
})

test('the temp file never survives a successful write', (t) => {
    const dir = tmpDir(t)
    const path = join(dir, 'epoch.key')
    writeSecretFileAtomic(fs, path, 'aa')
    assert.deepEqual(fs.readdirSync(dir), ['epoch.key'])
})

test('overwriting keeps the mode and replaces the contents', (t) => {
    const dir = tmpDir(t)
    const path = join(dir, 'owner.key')
    writeSecretFileAtomic(fs, path, 'aaaa')
    writeSecretFileAtomic(fs, path, 'bbbb')
    assert.equal(fs.readFileSync(path, 'utf8'), 'bbbb')
    assert.equal(modeOf(path), SECRET_FILE_MODE)
})

test('a failed rename leaves the PREVIOUS key intact', (t) => {
    // The reason atomicity matters here: losing an epoch key makes that shared
    // base permanently undecryptable, so a botched write must never destroy the
    // copy that already worked.
    const dir = tmpDir(t)
    const path = join(dir, 'epoch.key')
    writeSecretFileAtomic(fs, path, 'goodkey')

    const brokenFs = { ...fs, renameSync: () => { throw new Error('ENOSPC') } }
    assert.equal(writeSecretFileAtomic(brokenFs, path, 'newkey'), false)
    assert.equal(fs.readFileSync(path, 'utf8'), 'goodkey', 'the old key must survive a failed write')
})

test('an adapter without chmod or fsync still persists the secret', (t) => {
    // bare-fs / pear expose overlapping but not identical surfaces. Weaker
    // guarantees are acceptable; refusing to persist a key is not.
    const dir = tmpDir(t)
    const path = join(dir, 'epoch-enc.key')
    const minimalFs = {
        writeFileSync: fs.writeFileSync.bind(fs),
        renameSync: fs.renameSync.bind(fs),
    }
    assert.equal(writeSecretFileAtomic(minimalFs, path, 'cafe'), true)
    assert.equal(fs.readFileSync(path, 'utf8'), 'cafe')
})

test('an adapter without renameSync falls back to an in-place write', (t) => {
    const dir = tmpDir(t)
    const path = join(dir, 'epoch.key')
    const noRename = {
        writeFileSync: fs.writeFileSync.bind(fs),
        chmodSync: fs.chmodSync.bind(fs),
    }
    assert.equal(writeSecretFileAtomic(noRename, path, 'f00d'), true)
    assert.equal(fs.readFileSync(path, 'utf8'), 'f00d')
    assert.equal(modeOf(path), SECRET_FILE_MODE, 'the fallback path must still be owner-only')
})

test('a write failure is reported rather than thrown', (t) => {
    const dir = tmpDir(t)
    const brokenFs = { writeFileSync: () => { throw new Error('EACCES') } }
    assert.equal(writeSecretFileAtomic(brokenFs, join(dir, 'x.key'), 'aa'), false)
})

test('the containing directory is restricted to its owner', (t) => {
    const dir = tmpDir(t)
    assert.equal(hardenSecretDir(fs, dir), true)
    assert.equal(modeOf(dir), SECRET_DIR_MODE)
})

test('a legacy world-readable key is tightened on read, contents untouched', (t) => {
    const dir = tmpDir(t)
    const path = join(dir, 'epoch.key')
    fs.writeFileSync(path, 'legacykey')
    fs.chmodSync(path, 0o644)

    assert.equal(tightenSecretFile(fs, path), true)
    assert.equal(modeOf(path), SECRET_FILE_MODE)
    assert.equal(fs.readFileSync(path, 'utf8'), 'legacykey', 'migration must never touch contents')
})

test('tightening is idempotent and never widens a stricter mode', (t) => {
    const dir = tmpDir(t)
    const already = join(dir, 'a.key')
    writeSecretFileAtomic(fs, already, 'aa')
    assert.equal(tightenSecretFile(fs, already), false, 'already 0600')

    const stricter = join(dir, 'b.key')
    fs.writeFileSync(stricter, 'bb')
    fs.chmodSync(stricter, 0o400)
    assert.equal(tightenSecretFile(fs, stricter), false, 'a deliberately stricter mode is left alone')
    assert.equal(modeOf(stricter), 0o400)
})
