import test from 'node:test'
import assert from 'node:assert/strict'
import {
    acceptsItemFromBase,
    buildAuthoritativeBaseIndex,
    isFromAuthoritativeBase,
    listBaseFromRegistryItem,
} from './authoritative-base.mjs'

const SHARED = 'a1b2c3'
const registry = {
    lists: [
        { id: 'groceries', baseKey: null },       // still in the personal base
        { id: 'holiday', baseKey: SHARED },       // promoted to its own base
    ],
}
const index = buildAuthoritativeBaseIndex(registry)

const item = (listId, baseKey) => ({ id: 'i1', text: 'Milk', listId, ...(baseKey ? { baseKey } : {}) })

test('the index records where each list\'s items live', () => {
    assert.equal(index.get('groceries'), null)
    assert.equal(index.get('holiday'), SHARED)
    assert.equal(index.size, 2)
})

test('a promoted list accepts its shared base and rejects the personal one', () => {
    assert.equal(isFromAuthoritativeBase(item('holiday', SHARED), index), true)
    assert.equal(isFromAuthoritativeBase(item('holiday', null), index), false)
})

test('THE REGRESSION: a late personal tombstone cannot empty a promoted list', () => {
    // Sharing re-seeds items into the new base with the SAME ids, then tombstones
    // the personal copies. The two bases replicate independently, so the delete
    // can land after the seed — and identityKey (listId + itemId, no base) makes
    // it match. Without this guard the freshly shared list goes empty.
    const seeded = { id: 'x1', text: 'Passports', listId: 'holiday', baseKey: SHARED }
    const lateTombstone = { id: 'x1', text: 'Passports', listId: 'holiday', deleted: true }

    assert.equal(isFromAuthoritativeBase(seeded, index), true, 'the shared copy is authoritative')
    assert.equal(isFromAuthoritativeBase(lateTombstone, index), false, 'the personal tombstone must be ignored')
})

test('an un-shared list rejects events from the base it left', () => {
    assert.equal(isFromAuthoritativeBase(item('groceries', null), index), true)
    assert.equal(isFromAuthoritativeBase(item('groceries', SHARED), index), false)
})

test('FAILS OPEN for a list the registry does not know', () => {
    // Dropping items because the registry has not replicated yet would turn a
    // slow sync into data loss — much worse than the race being guarded.
    assert.equal(isFromAuthoritativeBase(item('brand-new', null), index), true)
    assert.equal(isFromAuthoritativeBase(item('brand-new', SHARED), index), true)
})

test('FAILS OPEN when there is no registry at all', () => {
    const empty = buildAuthoritativeBaseIndex(null)
    assert.equal(empty.size, 0)
    assert.equal(isFromAuthoritativeBase(item('holiday', null), empty), true)
    assert.equal(isFromAuthoritativeBase(item('anything', 'ffff'), empty), true)
})

test('base keys compare case- and whitespace-insensitively', () => {
    assert.equal(isFromAuthoritativeBase(item('holiday', SHARED.toUpperCase()), index), true)
    assert.equal(isFromAuthoritativeBase(item('holiday', ` ${SHARED} `), index), true)
})

test('an empty-string baseKey means the personal base, not a shared one', () => {
    assert.equal(isFromAuthoritativeBase(item('groceries', ''), index), true)
    assert.equal(isFromAuthoritativeBase(item('holiday', ''), index), false)
})

test('malformed input is accepted rather than dropped', () => {
    for (const value of [null, undefined, 42, 'nope']) {
        assert.equal(isFromAuthoritativeBase(value, index), true, String(value))
    }
})

test('malformed registry entries are skipped, not fatal', () => {
    const messy = buildAuthoritativeBaseIndex({ lists: [null, {}, { id: '' }, { id: 'ok', baseKey: 'FF' }] })
    assert.equal(messy.size, 1)
    assert.equal(messy.get('ok'), 'ff')
})

test('the convenience form matches the indexed form', () => {
    assert.equal(acceptsItemFromBase(item('holiday', null), registry), false)
    assert.equal(acceptsItemFromBase(item('holiday', SHARED), registry), true)
})

test('a plain object index works exactly like a Map', () => {
    // Reducers keep this in Immer state, where a Map is awkward and rebuilding
    // one per event would allocate on the client's hottest path.
    const obj = { groceries: null, holiday: SHARED }
    assert.equal(isFromAuthoritativeBase(item('holiday', SHARED), obj), true)
    assert.equal(isFromAuthoritativeBase(item('holiday', null), obj), false)
    assert.equal(isFromAuthoritativeBase(item('unknown', SHARED), obj), true, 'fails open')
})

test('listBaseFromRegistryItem extracts the routing decision', () => {
    const meta = { id: 'holiday', regKind: 'list', regName: 'Holiday', regBaseKey: SHARED }
    assert.deepEqual(listBaseFromRegistryItem(meta), { listId: 'holiday', baseKey: SHARED })

    const personal = { id: 'groceries', regKind: 'list', regName: 'Groceries' }
    assert.deepEqual(listBaseFromRegistryItem(personal), { listId: 'groceries', baseKey: null })
})

test('a SHARED base\'s own meta-item never overwrites the personal routing', () => {
    // A shared base seeds a self-describing meta-item tagged with its own
    // baseKey. That describes the base, not where the personal registry says the
    // list lives — letting it win would make the guard argue with itself.
    const fromShared = { id: 'holiday', regKind: 'list', regBaseKey: SHARED, baseKey: SHARED }
    assert.equal(listBaseFromRegistryItem(fromShared), null)
})

test('listBaseFromRegistryItem ignores non-list records', () => {
    for (const value of [null, undefined, {}, { regKind: 'group', id: 'g1' }, { regKind: 'list' }]) {
        assert.equal(listBaseFromRegistryItem(value), null, JSON.stringify(value))
    }
})
