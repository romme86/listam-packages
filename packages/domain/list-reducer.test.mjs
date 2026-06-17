import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createListOperation,
    createListReduction,
    reduceListOperations,
} from './list-reducer.mjs'
import {
    identityKey,
    updateListEntry,
    upsertListEntry,
} from './identity.mjs'

function item(fields) {
    return {
        text: fields.text,
        isDone: fields.isDone ?? false,
        timeOfCompletion: fields.timeOfCompletion ?? 0,
        ...fields,
    }
}

test('domain reduction keeps distinct ids for duplicate item names', () => {
    const milkA = item({ id: 'milk-a', text: 'Milk', updatedAt: 1 })
    const milkB = item({ id: 'milk-b', text: 'Milk', updatedAt: 2 })

    const reduced = reduceListOperations([
        createListOperation('add', milkA),
        createListOperation('add', milkB),
        createListOperation('update', { ...milkA, isDone: true, updatedAt: 3 }),
    ]).items

    assert.deepEqual(reduced.map((entry) => entry.id), ['milk-b', 'milk-a'])
    assert.equal(reduced.find((entry) => entry.id === 'milk-a').isDone, true)
})

test('array projection and reducer agree on stale updates', () => {
    const milk = item({ id: 'milk', text: 'Milk', updatedAt: 5 })
    const newer = item({ ...milk, isDone: true, timeOfCompletion: 50, updatedAt: 9 })
    const stale = item({ ...milk, isDone: false, timeOfCompletion: 0, updatedAt: 2 })

    const reduced = reduceListOperations([
        createListOperation('add', milk),
        createListOperation('update', newer),
        createListOperation('update', stale),
    ]).items

    let projected = []
    projected = upsertListEntry(projected, milk)
    projected = updateListEntry(projected, newer)
    projected = updateListEntry(projected, stale)

    assert.deepEqual(projected.map(identityKey), reduced.map(identityKey))
    assert.equal(projected[0].isDone, true)
    assert.equal(reduced[0].isDone, true)
})

test('allItems() spans every list bucket while items() stays single-list', () => {
    // The selected list is the grocery list; registry meta-items and board
    // tickets live in their own buckets and must survive a restart rebuild.
    const reduction = createListReduction({ selectedListId: 'local' })
    const grocery = item({ id: 'g1', text: 'Milk', updatedAt: 1, listId: 'local' })
    const ticket = item({ id: 'k1', text: 'Ticket', updatedAt: 1, listId: 'board-1', listType: 'board' })
    const board = item({ id: 'board-1', text: 'Board', updatedAt: 1, listId: '__registry__', listType: 'registry' })

    reduction.applyOperation(createListOperation('add', grocery))
    reduction.applyOperation(createListOperation('add', ticket))
    reduction.applyOperation(createListOperation('add', board))

    // items() is scoped to the selected list — it drops the other buckets.
    assert.deepEqual(reduction.items().map((e) => e.id), ['g1'])

    // allItems() carries every bucket, so the rebuild can re-project them.
    assert.deepEqual(reduction.allItems().map((e) => e.id).sort(), ['board-1', 'g1', 'k1'])
})
