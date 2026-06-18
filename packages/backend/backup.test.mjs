import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptBackup, decryptBackup, BACKUP_FORMAT } from './lib/backup-crypto.mjs'
import {
    buildDataSnapshot,
    parseDataSnapshot,
    snapshotItemsToOps,
    buildSeedPayload,
    parseSeedPayload,
    missingRequiredSeeds,
} from './lib/backup-payload.mjs'

const PASSWORD = 'correct horse battery staple'

function sampleItem (over = {}) {
    return {
        id: 'item-1',
        text: 'Milk',
        isDone: false,
        timeOfCompletion: 0,
        listId: 'default',
        listType: 'shopping',
        updatedAt: 1700000000000,
        ...over,
    }
}

// ---- crypto ---------------------------------------------------------------

test('encrypt → decrypt round-trips a data payload', () => {
    const snapshot = buildDataSnapshot({ items: [sampleItem()], boardConfig: null })
    const file = encryptBackup(snapshot, PASSWORD, 'data', { createdAt: 123 })
    const env = JSON.parse(file)
    assert.equal(env.format, BACKUP_FORMAT)
    assert.equal(env.kind, 'data')
    assert.ok(!file.includes('Milk'), 'plaintext must not leak into the envelope')

    const decoded = decryptBackup(file, PASSWORD)
    assert.equal(decoded.kind, 'data')
    assert.equal(decoded.createdAt, 123)
    assert.deepEqual(parseDataSnapshot(decoded.payload).items[0].text, 'Milk')
})

test('a wrong password is rejected', () => {
    const file = encryptBackup(buildSeedPayload({ autobaseKey: 'ab' }), PASSWORD, 'seed')
    assert.throws(() => decryptBackup(file, 'nope'), /Wrong password/)
})

test('a tampered ciphertext is rejected', () => {
    const env = JSON.parse(encryptBackup(buildDataSnapshot({ items: [sampleItem()] }), PASSWORD, 'data'))
    const ct = Buffer.from(env.ct, 'base64')
    ct[0] ^= 0xff
    env.ct = ct.toString('base64')
    assert.throws(() => decryptBackup(JSON.stringify(env), PASSWORD), /tampered|corrupt/i)
})

test('kind is authenticated: a seed file cannot open as data', () => {
    // Forge the envelope `kind` to 'data'; the AEAD AAD binds the real kind, so
    // even the right password fails the auth check.
    const env = JSON.parse(encryptBackup(buildSeedPayload({ autobaseKey: 'ab' }), PASSWORD, 'seed'))
    env.kind = 'data'
    assert.throws(() => decryptBackup(JSON.stringify(env), PASSWORD), /tampered|corrupt/i)
})

test('an empty password is refused on both ends', () => {
    assert.throws(() => encryptBackup(buildDataSnapshot({}), '', 'data'), /password is required/)
    const file = encryptBackup(buildDataSnapshot({}), PASSWORD, 'data')
    assert.throws(() => decryptBackup(file, ''), /password is required/)
})

test('a non-backup file is rejected cleanly', () => {
    assert.throws(() => decryptBackup('{"hello":1}', PASSWORD), /not a valid Listam backup/)
    assert.throws(() => decryptBackup('not json', PASSWORD), /not a valid Listam backup/)
})

// ---- payload --------------------------------------------------------------

test('snapshot items convert to add ops preserving id and updatedAt', () => {
    const items = [sampleItem(), sampleItem({ id: 'item-2', text: 'Eggs', updatedAt: 1700000005000 })]
    const ops = snapshotItemsToOps(items)
    assert.equal(ops.length, 2)
    for (const [i, op] of ops.entries()) {
        assert.equal(op.type, 'add')
        assert.equal(op.value.id, items[i].id)
        assert.equal(op.value.updatedAt, items[i].updatedAt)
        assert.equal(op.value.text, items[i].text)
    }
})

test('snapshotItemsToOps is deterministic, so re-import is an LWW no-op', () => {
    const items = [sampleItem({ status: 'in_progress', listType: 'board', inProgressMs: 5 })]
    assert.deepEqual(snapshotItemsToOps(items), snapshotItemsToOps(items))
})

test('registry meta-items survive the snapshot → ops round-trip', () => {
    const registryItem = {
        id: 'list-abc',
        text: 'Groceries',
        isDone: false,
        timeOfCompletion: 0,
        listId: '__registry__',
        listType: 'registry',
        updatedAt: 1700000000000,
        regKind: 'list',
        regName: 'Groceries',
        regType: 'shopping',
        regOrder: 2,
    }
    const ops = snapshotItemsToOps(parseDataSnapshot(buildDataSnapshot({ items: [registryItem] })).items)
    assert.equal(ops.length, 1)
    assert.equal(ops[0].value.regKind, 'list')
    assert.equal(ops[0].value.regName, 'Groceries')
    assert.equal(ops[0].listId, '__registry__')
})

test('items without an id are dropped from the snapshot', () => {
    const snapshot = buildDataSnapshot({ items: [sampleItem(), { text: 'no id' }, null] })
    assert.equal(snapshot.items.length, 1)
})

test('seed payload keeps only known secret names, parse mirrors it', () => {
    const payload = buildSeedPayload({
        autobaseKey: 'a'.repeat(64),
        encryptionKey: 'b'.repeat(64),
        ownerAuthorityKey: 'c'.repeat(128),
        epochKey: 'd'.repeat(64),
        epochEncryptionKey: 'e'.repeat(64),
        controlDeviceSeed: 'should-not-survive',
    })
    assert.equal(payload.secrets.controlDeviceSeed, undefined)
    const parsed = parseSeedPayload(payload)
    assert.equal(parsed.autobaseKey, 'a'.repeat(64))
    assert.equal(parsed.epochEncryptionKey, 'e'.repeat(64))
    assert.equal(missingRequiredSeeds(parsed).length, 0)
})

test('missingRequiredSeeds flags a guest seed (no owner authority)', () => {
    const parsed = parseSeedPayload(buildSeedPayload({
        autobaseKey: 'a'.repeat(64),
        encryptionKey: 'b'.repeat(64),
    }))
    assert.deepEqual(missingRequiredSeeds(parsed), ['ownerAuthorityKey'])
})
