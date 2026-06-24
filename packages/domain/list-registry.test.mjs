import test from 'node:test'
import assert from 'node:assert/strict'
import {
    REGISTRY_LIST_ID,
    REGISTRY_LIST_TYPE,
    isRegistryItem,
    buildListMetaItem,
    buildGroupMetaItem,
    reduceRegistry,
    sanitizeView,
} from './list-registry.mjs'

test('buildListMetaItem / buildGroupMetaItem produce well-shaped registry items', () => {
    const l = buildListMetaItem({ id: 'groceries', name: 'Groceries', type: 'shopping', groupId: 'g1', order: 2, updatedAt: 5 })
    assert.equal(l.id, 'groceries')
    assert.equal(l.listId, REGISTRY_LIST_ID)
    assert.equal(l.listType, REGISTRY_LIST_TYPE)
    assert.equal(l.isDone, false)
    assert.equal(l.regKind, 'list')
    assert.equal(l.regType, 'shopping')
    assert.equal(l.regGroupId, 'g1')
    assert.equal(l.regOrder, 2)
    assert.equal(isRegistryItem(l), true)

    const g = buildGroupMetaItem({ id: 'g1', name: 'Workspace', order: 0, updatedAt: 1 })
    assert.equal(g.regKind, 'group')
    assert.equal(isRegistryItem(g), true)
    assert.equal(isRegistryItem({ listType: 'kanban' }), false)
})

test('regBaseKey: written only when given; reduceRegistry surfaces it as baseKey (null otherwise)', () => {
    const personal = buildListMetaItem({ id: 'a', name: 'A', type: 'shopping', updatedAt: 1 })
    assert.equal('regBaseKey' in personal, false) // back-compat: no field for personal-base lists
    const shared = buildListMetaItem({ id: 'b', name: 'B', type: 'shopping', baseKey: 'deadbeef', updatedAt: 1 })
    assert.equal(shared.regBaseKey, 'deadbeef')

    const reg = reduceRegistry([personal, shared])
    const byId = Object.fromEntries(reg.lists.map((l) => [l.id, l]))
    assert.equal(byId.a.baseKey, null)
    assert.equal(byId.b.baseKey, 'deadbeef')
})

test('reduceRegistry partitions and sorts groups + lists', () => {
    const items = [
        buildGroupMetaItem({ id: 'g2', name: 'Trips', order: 1, updatedAt: 1 }),
        buildGroupMetaItem({ id: 'g1', name: 'Workspace', order: 0, updatedAt: 1 }),
        buildListMetaItem({ id: 'b', name: 'Bananas list', type: 'shopping', groupId: 'g1', order: 1, updatedAt: 1 }),
        buildListMetaItem({ id: 'a', name: 'Apples list', type: 'shopping', groupId: 'g1', order: 0, updatedAt: 1 }),
        { id: 'x', listType: 'kanban', text: 'not registry' }, // ignored
    ]
    const reg = reduceRegistry(items)
    assert.deepEqual(reg.groups.map((g) => g.id), ['g1', 'g2'])
    assert.deepEqual(reg.lists.map((l) => l.id), ['a', 'b'])
    assert.equal(reg.lists[0].groupId, 'g1')
})

test('reduceRegistry LWW-dedupes by id keeping the newest updatedAt', () => {
    const items = [
        buildListMetaItem({ id: 'a', name: 'Old name', type: 'shopping', order: 0, updatedAt: 1 }),
        // Legacy 'kanban' wire value persisted before the board rename.
        buildListMetaItem({ id: 'a', name: 'New name', type: 'kanban', order: 0, updatedAt: 9 }),
    ]
    const reg = reduceRegistry(items)
    assert.equal(reg.lists.length, 1)
    assert.equal(reg.lists[0].name, 'New name')
    // reduceRegistry normalizes the legacy value to the canonical 'board'.
    assert.equal(reg.lists[0].type, 'board')
})

test('reduceRegistry passes a net-new todo type through unchanged (no normalization)', () => {
    // Unlike the legacy kanban→board rewrite, 'todo' is a canonical wire value
    // with no dual-read shim, so it must survive a round-trip verbatim — both on
    // a current peer and on an older peer that has no concept of the type.
    const reg = reduceRegistry([
        buildListMetaItem({ id: 'chores', name: 'Chores', type: 'todo', order: 0, updatedAt: 1 }),
    ])
    assert.equal(reg.lists.length, 1)
    assert.equal(reg.lists[0].type, 'todo')
    assert.equal(reg.lists[0].name, 'Chores')
})

test('reduceRegistry drops tombstoned entries', () => {
    const live = buildListMetaItem({ id: 'a', name: 'Keep', type: 'shopping', order: 0, updatedAt: 1 })
    const dead = { ...buildListMetaItem({ id: 'b', name: 'Gone', type: 'shopping', order: 1, updatedAt: 2 }), regDeleted: true }
    const reg = reduceRegistry([live, dead])
    assert.deepEqual(reg.lists.map((l) => l.id), ['a'])
})

test('reduceRegistry tolerates empty/garbage input', () => {
    assert.deepEqual(reduceRegistry([]), { groups: [], lists: [] })
    assert.deepEqual(reduceRegistry(null), { groups: [], lists: [] })
    assert.deepEqual(reduceRegistry([null, { listType: 'shopping' }]), { groups: [], lists: [] })
})

test('sanitizeView keeps only known keys with valid values', () => {
    const v = sanitizeView({
        isGridView: true,
        showFab: 'yes',                 // wrong type → dropped
        gridIconSize: 'huge',           // invalid enum → dropped
        listAlignment: 'center',        // valid
        bogus: 1,                       // unknown → dropped
    })
    assert.deepEqual(v, { isGridView: true, listAlignment: 'center' })
    assert.deepEqual(sanitizeView(null), {})
    assert.deepEqual(sanitizeView('nope'), {})
})

test('buildListMetaItem carries a sanitized regView only when view is given', () => {
    const without = buildListMetaItem({ id: 'a', name: 'A', type: 'shopping', updatedAt: 1 })
    assert.equal('regView' in without, false) // back-compat: no view → no key

    const withView = buildListMetaItem({
        id: 'a', name: 'A', type: 'shopping', updatedAt: 1,
        view: { isGridView: true, listTextSize: 'large', junk: 9 },
    })
    assert.deepEqual(withView.regView, { isGridView: true, listTextSize: 'large' })
})

test('reduceRegistry surfaces a list view; absent regView → undefined', () => {
    const reg = reduceRegistry([
        buildListMetaItem({ id: 'a', name: 'A', type: 'shopping', order: 0, updatedAt: 1, view: { isGridView: true } }),
        buildListMetaItem({ id: 'b', name: 'B', type: 'shopping', order: 1, updatedAt: 1 }),
    ])
    assert.deepEqual(reg.lists.find((l) => l.id === 'a').view, { isGridView: true })
    assert.equal(reg.lists.find((l) => l.id === 'b').view, undefined)
})

test('reduceRegistry LWW replaces the whole view on a newer write', () => {
    const reg = reduceRegistry([
        buildListMetaItem({ id: 'a', name: 'A', type: 'shopping', order: 0, updatedAt: 1, view: { isGridView: true, showFab: true } }),
        buildListMetaItem({ id: 'a', name: 'A', type: 'shopping', order: 0, updatedAt: 9, view: { isGridView: false } }),
    ])
    assert.deepEqual(reg.lists[0].view, { isGridView: false }) // whole-item replace, not merge
})
