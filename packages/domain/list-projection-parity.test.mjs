import test from 'node:test'
import assert from 'node:assert/strict'
import { createListOperation, createListViewEntry, reduceListViewEntries } from './list-reducer.mjs'
import {
    identityKey,
    deleteListEntry,
    normalizeListEntries,
    updateListEntry,
    upsertListEntry,
} from './identity.mjs'

// Phase 5 acceptance: "the backend materialized view and the UI projection agree
// on duplicate names." The backend reduces the persisted view log; the UI folds
// the same operations through the array projection the worklet RPC echoes drive.
// These run two different algorithms (Map reduction vs. incremental array ops)
// over the shared identity module, so this guards them against ever diverging.

function backendView(ops) {
    return reduceListViewEntries(ops.map(createListViewEntry)).items
}

function uiProjection(ops) {
    let list = []
    for (const op of ops) {
        if (op.type === 'list') list = normalizeListEntries(op.value)
        else if (op.type === 'delete') list = deleteListEntry(list, op.value)
        else if (op.type === 'update') list = updateListEntry(list, op.value)
        else list = upsertListEntry(list, op.value)
    }
    return list
}

function assertParity(ops) {
    const view = backendView(ops)
    const ui = uiProjection(ops)
    assert.deepEqual(
        ui.map(identityKey),
        view.map(identityKey),
        'projection id/order disagrees with the materialized view',
    )
    for (const viewItem of view) {
        const uiItem = ui.find((entry) => identityKey(entry) === identityKey(viewItem))
        assert.ok(uiItem, `UI projection missing ${identityKey(viewItem)}`)
        assert.equal(uiItem.text, viewItem.text)
        assert.equal(uiItem.isDone, viewItem.isDone)
        assert.equal(uiItem.timeOfCompletion, viewItem.timeOfCompletion)
    }
    return view
}

function item(fields) {
    return { text: fields.text, isDone: false, timeOfCompletion: 0, ...fields }
}

test('view and projection agree on duplicate names with distinct ids', () => {
    const milkA = item({ id: 'milk-a', text: 'Milk', updatedAt: 1 })
    const milkB = item({ id: 'milk-b', text: 'Milk', updatedAt: 2 })
    const view = assertParity([
        createListOperation('add', milkA),
        createListOperation('add', milkB),
        createListOperation('update', { ...milkA, isDone: true, timeOfCompletion: 9, updatedAt: 3 }),
        createListOperation('delete', milkB),
    ])
    assert.deepEqual(view.map((entry) => entry.id), ['milk-a'])
    assert.equal(view[0].isDone, true)
})

test('view and projection agree on legacy text-only ops', () => {
    assertParity([
        createListOperation('add', item({ text: 'Milk' })),
        createListOperation('add', item({ text: 'Eggs' })),
        createListOperation('update', item({ text: 'Milk', isDone: true, timeOfCompletion: 7 })),
        createListOperation('delete', item({ text: 'Eggs' })),
    ])
})

test('view and projection agree when a stale update arrives last', () => {
    const milk = item({ id: 'm1', text: 'Milk', updatedAt: 5 })
    const view = assertParity([
        createListOperation('add', milk),
        createListOperation('update', { ...milk, isDone: true, timeOfCompletion: 50, updatedAt: 9 }),
        createListOperation('update', { ...milk, isDone: false, timeOfCompletion: 0, updatedAt: 2 }),
    ])
    assert.equal(view[0].isDone, true)
})

test('view and projection agree after a full list-snapshot replace', () => {
    assertParity([
        createListOperation('add', item({ id: 'a', text: 'Apples', updatedAt: 1 })),
        createListOperation('list', [
            item({ id: 'b', text: 'Bananas', updatedAt: 2 }),
            item({ id: 'c', text: 'Cherries', updatedAt: 3 }),
        ]),
        createListOperation('add', item({ id: 'd', text: 'Dates', updatedAt: 4 })),
    ])
})
