import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeSyncListSnapshot } from './sync-list-snapshot.mjs'

test('a bare array is the legacy personal/default snapshot', () => {
    const items = [{ id: 'a', text: 'Milk' }]
    assert.deepEqual(decodeSyncListSnapshot(items), { mode: 'legacy', items, baseKey: null })
})

test('an exact bucket envelope keeps its identity', () => {
    const snap = decodeSyncListSnapshot({ list: [], listId: 'groceries', listType: 'shopping' })
    assert.deepEqual(snap, { mode: 'bucket', listId: 'groceries', listType: 'shopping', items: [], baseKey: null })
})

test('an EMPTY bucket envelope survives — this is how a bucket is cleared', () => {
    // The regression this decoder exists to prevent: `Array.isArray(v) ? v : []`
    // turns every non-default bucket into an empty list, losing its identity so
    // the receiver cannot tell "this bucket is now empty" from "no data".
    const snap = decodeSyncListSnapshot({ list: [], listId: 'todo', listType: 'todo' })
    assert.equal(snap.mode, 'bucket')
    assert.equal(snap.items.length, 0)
    assert.equal(snap.listId, 'todo')
})

test('a shared-base envelope carries its baseKey', () => {
    const snap = decodeSyncListSnapshot({ list: [{ id: 'x' }], listId: 'l', listType: 'todo', baseKey: 'ab12' })
    assert.equal(snap.baseKey, 'ab12')
})

test('an older { list, baseKey } envelope infers identity from its items', () => {
    const snap = decodeSyncListSnapshot({
        list: [{ id: 'x', listId: 'shared-1', listType: 'todo' }],
        baseKey: 'ff00',
    })
    assert.deepEqual(snap, {
        mode: 'bucket',
        listId: 'shared-1',
        listType: 'todo',
        items: [{ id: 'x', listId: 'shared-1', listType: 'todo' }],
        baseKey: 'ff00',
    })
})

test('an envelope with nothing to infer from degrades to legacy, never to null', () => {
    // Dropping the snapshot would lose data; treating it as an untagged list is
    // exactly what receivers did before bucket identity existed.
    const snap = decodeSyncListSnapshot({ list: [], baseKey: 'ff00' })
    assert.deepEqual(snap, { mode: 'legacy', items: [], baseKey: 'ff00' })
})

test('the first non-object entry does not defeat inference', () => {
    const snap = decodeSyncListSnapshot({ list: [null, { id: 'x', listId: 'l2', listType: 'board' }] })
    assert.equal(snap.mode, 'bucket')
    assert.equal(snap.listId, 'l2')
})

test('genuinely unusable payloads return null', () => {
    for (const value of [null, undefined, 42, 'nope', {}, { list: 'not-an-array' }]) {
        assert.equal(decodeSyncListSnapshot(value), null, JSON.stringify(value) ?? 'undefined')
    }
})
