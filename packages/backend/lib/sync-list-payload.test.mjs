import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSyncListPayload } from './sync-list-payload.mjs'

test('default personal snapshots preserve the legacy bare-array payload', () => {
    const currentList = [{ id: 'milk', listId: 'default' }]
    const operation = { type: 'list', listId: 'default', listType: 'shopping', value: currentList }

    assert.strictEqual(buildSyncListPayload({ role: 'personal', operation, currentList }), currentList)
})

test('non-default personal snapshots identify and carry their exact bucket', () => {
    const currentList = [{ id: 'milk', listId: 'default' }]
    const plan = [{ id: 'i:default::milk', listId: '__plan__', listType: 'plan' }]
    const operation = { type: 'list', listId: '__plan__', listType: 'plan', value: plan }

    assert.deepEqual(buildSyncListPayload({ role: 'personal', operation, currentList }), {
        list: plan,
        listId: '__plan__',
        listType: 'plan',
    })
})

test('an empty non-default snapshot remains an explicit bucket replacement', () => {
    const operation = { type: 'list', listId: '__peers__', listType: 'peer', value: [] }

    assert.deepEqual(buildSyncListPayload({ role: 'personal', operation, currentList: [] }), {
        list: [],
        listId: '__peers__',
        listType: 'peer',
    })
})

test('shared snapshots retain baseKey and identify their exact bucket', () => {
    const currentList = [{ id: 'stale', listId: 'shared-list' }]
    const snapshot = [{ id: 'ticket', listId: 'shared-list' }]
    const operation = { type: 'list', listId: 'shared-list', listType: 'board', value: snapshot }

    assert.deepEqual(buildSyncListPayload({
        role: 'shared',
        baseKeyHex: 'aabbcc',
        operation,
        currentList,
    }), {
        list: snapshot,
        listId: 'shared-list',
        listType: 'board',
        baseKey: 'aabbcc',
    })
})
