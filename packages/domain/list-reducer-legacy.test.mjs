import test from 'node:test'
import assert from 'node:assert/strict'
import {
    DEFAULT_LIST_ID,
    DEFAULT_LIST_TYPE,
    LIST_OPERATION_VERSION,
    createListOperation,
    legacyItemId,
    reduceListOperations,
    reduceListViewEntries,
} from './list-reducer.mjs'

function item(fields) {
    return {
        text: fields.text,
        isDone: fields.isDone ?? false,
        timeOfCompletion: fields.timeOfCompletion ?? 0,
        ...fields,
    }
}

test('new list operations are versioned and default to the implicit shopping list', () => {
    const operation = createListOperation('add', item({ id: 'a1', text: 'Milk', updatedAt: 10 }))

    assert.equal(operation.version, LIST_OPERATION_VERSION)
    assert.equal(operation.listId, DEFAULT_LIST_ID)
    assert.equal(operation.listType, DEFAULT_LIST_TYPE)
    assert.equal(operation.value.id, 'a1')
    assert.equal(operation.value.listId, DEFAULT_LIST_ID)
    assert.equal(operation.value.listType, DEFAULT_LIST_TYPE)
})

test('legacy text-only view entries backfill ids without losing done state or add order', () => {
    const { items } = reduceListViewEntries([
        { op: 'add', text: 'Milk', isDone: false, timeOfCompletion: 0 },
        { op: 'add', text: 'Eggs', isDone: false, timeOfCompletion: 0 },
        { op: 'update', text: 'Milk', isDone: true, timeOfCompletion: 123 },
    ])

    assert.deepEqual(items.map((entry) => entry.text), ['Eggs', 'Milk'])
    assert.equal(items[1].id, legacyItemId('Milk'))
    assert.equal(items[1].isDone, true)
    assert.equal(items[1].timeOfCompletion, 123)
})

test('id-keyed duplicate names converge without collapsing distinct items', () => {
    const milkA = item({ id: 'milk-a', text: 'Milk', updatedAt: 1 })
    const milkB = item({ id: 'milk-b', text: 'Milk', updatedAt: 2 })

    const materialized = reduceListOperations([
        createListOperation('add', milkA),
        createListOperation('add', milkB),
        createListOperation('update', { ...milkA, isDone: true, timeOfCompletion: 50, updatedAt: 3 }),
    ]).items

    assert.equal(materialized.length, 2)
    assert.deepEqual(materialized.map((entry) => entry.id), ['milk-b', 'milk-a'])
    assert.equal(materialized.find((entry) => entry.id === 'milk-a').isDone, true)
    assert.equal(materialized.find((entry) => entry.id === 'milk-b').isDone, false)

    const afterDelete = reduceListOperations([
        createListOperation('add', milkA),
        createListOperation('add', milkB),
        createListOperation('delete', milkA),
    ]).items

    assert.deepEqual(afterDelete.map((entry) => entry.id), ['milk-b'])
})

test('mixed legacy and new logs replay compatibly', () => {
    const legacyMilk = item({ text: 'Milk' })
    const newMilk = item({ id: 'new-milk', text: 'Milk', updatedAt: 10 })

    const { items } = reduceListOperations([
        { type: 'add', value: legacyMilk },
        createListOperation('add', newMilk),
        { type: 'delete', value: legacyMilk },
    ])

    assert.deepEqual(items.map((entry) => entry.id), ['new-milk'])
    assert.deepEqual(items.map((entry) => entry.text), ['Milk'])
})

test('legacy view delete entries with only text remove the derived legacy item', () => {
    const { items } = reduceListViewEntries([
        { op: 'add', text: 'Milk', isDone: true, timeOfCompletion: 100 },
        { op: 'delete', text: 'Milk' },
    ])

    assert.deepEqual(items, [])
})

test('a stale update (older updatedAt) does not clobber a newer item', () => {
    const milk = item({ id: 'm1', text: 'Milk', updatedAt: 5 })

    // A late-arriving edit carrying an older timestamp must not revert the newer
    // state, regardless of the order it replays in.
    const newerThenStale = reduceListOperations([
        createListOperation('add', milk),
        createListOperation('update', { ...milk, isDone: true, timeOfCompletion: 50, updatedAt: 9 }),
        createListOperation('update', { ...milk, isDone: false, timeOfCompletion: 0, updatedAt: 3 }),
    ]).items

    assert.equal(newerThenStale.length, 1)
    assert.equal(newerThenStale[0].isDone, true)
    assert.equal(newerThenStale[0].timeOfCompletion, 50)
    assert.equal(newerThenStale[0].updatedAt, 9)
})

test('reduction partitions by listId while exposing the default list projection', () => {
    const personal = item({ id: 'p1', text: 'Apples', updatedAt: 1 })
    const work = item({ id: 'w1', listId: 'work', text: 'Apples', updatedAt: 2 })

    const reduced = reduceListOperations([
        createListOperation('add', personal),
        createListOperation('add', work, { listId: 'work' }),
    ])

    assert.deepEqual(reduced.items.map((entry) => entry.id), ['p1'])
    assert.equal(reduced.byList.get(DEFAULT_LIST_ID).order.length, 1)
    assert.equal(reduced.byList.get('work').order.length, 1)
    assert.equal(reduced.byList.get('work').items.get('w1').text, 'Apples')
})
