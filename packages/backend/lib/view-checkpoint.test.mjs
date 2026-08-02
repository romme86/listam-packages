import test from 'node:test'
import assert from 'node:assert/strict'
import { createViewCheckpoint } from './view-checkpoint.mjs'
import { createListViewEntry, reduceListViewEntries } from '@listam/domain/list-reducer'

function item(id, text, overrides = {}) {
    return {
        id,
        text,
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: 1,
        listId: 'default',
        listType: 'shopping',
        ...overrides,
    }
}

function addEntry(id, text) {
    return createListViewEntry({ type: 'add', value: item(id, text) })
}

function updateEntry(id, text, overrides = {}) {
    return createListViewEntry({ type: 'update', value: item(id, text, { updatedAt: 2, ...overrides }) })
}

function deleteEntry(id, text) {
    return createListViewEntry({ type: 'delete', value: item(id, text) })
}

// Fake linearized view: an entries array plus a read counter, so tests can
// assert exactly how much of the log each pass touches.
function createFakeView(entries = []) {
    const view = {
        entries,
        reads: 0,
        get length() {
            return entries.length
        },
        async get(i) {
            view.reads++
            const entry = entries[i]
            if (entry instanceof Error) throw entry
            return entry
        },
    }
    return view
}

test('the first pass reduces the full id-keyed log and matches the one-shot reduction', async () => {
    const entries = [
        addEntry('a', 'Milk'),
        addEntry('b', 'Bread'),
        updateEntry('a', 'Oat milk'),
        deleteEntry('b', 'Bread'),
        addEntry('c', 'Eggs'),
    ]
    const view = createFakeView(entries)
    const checkpoint = createViewCheckpoint()

    const result = await checkpoint.update(view)

    assert.equal(result.resumedFrom, 0)
    assert.equal(result.scanned, 5)
    assert.deepEqual(result.items, reduceListViewEntries(entries).items)
    assert.deepEqual(result.items.map((entry) => entry.text), ['Eggs', 'Oat milk'])
})

test('a later pass resumes from the checkpoint and reads only the appended tail', async () => {
    const view = createFakeView([addEntry('a', 'Milk'), addEntry('b', 'Bread')])
    const checkpoint = createViewCheckpoint()
    await checkpoint.update(view)
    const readsAfterFirstPass = view.reads

    view.entries.push(updateEntry('a', 'Oat milk'), addEntry('c', 'Eggs'))
    const result = await checkpoint.update(view)

    // One verification read of the last processed entry plus the two new ones.
    assert.equal(view.reads - readsAfterFirstPass, 3)
    assert.equal(result.resumedFrom, 2)
    assert.equal(result.scanned, 2)
    assert.deepEqual(result.items, reduceListViewEntries(view.entries).items)
})

test('repeated polling on an unchanged view stays bounded at one verification read per pass', async () => {
    const view = createFakeView([addEntry('a', 'Milk'), addEntry('b', 'Bread'), addEntry('c', 'Eggs')])
    const checkpoint = createViewCheckpoint()
    await checkpoint.update(view)
    const readsAfterFirstPass = view.reads

    // The join flow polls a rebuild every second for up to 120 attempts; each
    // poll must not replay the log from index 0.
    for (let poll = 0; poll < 120; poll++) {
        await checkpoint.update(view)
    }
    assert.equal(view.reads - readsAfterFirstPass, 120)
})

test('a truncated view (autobase reorg) falls back to a full replay', async () => {
    const view = createFakeView([addEntry('a', 'Milk'), addEntry('b', 'Bread'), addEntry('c', 'Eggs')])
    const checkpoint = createViewCheckpoint()
    await checkpoint.update(view)

    view.entries.length = 1
    view.entries.push(addEntry('d', 'Cheese'))
    const result = await checkpoint.update(view)

    assert.equal(result.resumedFrom, 0)
    assert.deepEqual(result.items, reduceListViewEntries(view.entries).items)
    assert.deepEqual(result.items.map((entry) => entry.text), ['Cheese', 'Milk'])
})

test('a same-length view whose history changed under the checkpoint is detected and fully replayed', async () => {
    const view = createFakeView([addEntry('a', 'Milk'), addEntry('b', 'Bread')])
    const checkpoint = createViewCheckpoint()
    await checkpoint.update(view)

    view.entries.splice(0, 2, addEntry('x', 'Tofu'), addEntry('y', 'Rice'))
    view.entries.push(addEntry('z', 'Beans'))
    const result = await checkpoint.update(view)

    assert.equal(result.resumedFrom, 0)
    assert.deepEqual(result.items, reduceListViewEntries(view.entries).items)
})

test('membership records are collected once each and excluded from the list reduction', async () => {
    const membership = { op: 'membership', record: { type: 'membership/add-writer@v1', sequence: 1 } }
    const view = createFakeView([membership, addEntry('a', 'Milk')])
    const checkpoint = createViewCheckpoint()

    const first = await checkpoint.update(view)
    assert.deepEqual(first.membershipRecords, [membership.record])
    assert.deepEqual(first.items.map((entry) => entry.text), ['Milk'])

    view.entries.push({ op: 'membership', record: { type: 'membership/add-writer@v1', sequence: 2 } })
    const second = await checkpoint.update(view)
    assert.equal(second.membershipRecords.length, 2, 'resume must not re-collect already-seen records')
})

test('an unreadable entry reports an incomplete result and forces a full retry', async () => {
    const readError = new Error('block read failed')
    const view = createFakeView([addEntry('a', 'Milk'), readError, addEntry('c', 'Eggs')])
    const checkpoint = createViewCheckpoint()

    const errors = []
    const result = await checkpoint.update(view, { onError: (index) => errors.push(index) })

    assert.deepEqual(errors, [1])
    assert.equal(result.complete, false)
    assert.deepEqual(result.items.map((entry) => entry.text), ['Eggs', 'Milk'])

    // Once the missing block becomes readable, the next pass starts from zero
    // and recovers it; the checkpoint never advances permanently past the gap.
    view.entries[1] = addEntry('b', 'Bread')
    view.entries.push(addEntry('d', 'Cheese'))
    const next = await checkpoint.update(view)
    assert.equal(next.complete, true)
    assert.equal(next.resumedFrom, 0)
    assert.deepEqual(next.items.map((entry) => entry.text), ['Cheese', 'Eggs', 'Bread', 'Milk'])
})

test('reset discards the checkpoint so the next pass replays from index 0', async () => {
    const view = createFakeView([addEntry('a', 'Milk')])
    const checkpoint = createViewCheckpoint()
    await checkpoint.update(view)

    checkpoint.reset()
    const result = await checkpoint.update(view)
    assert.equal(result.resumedFrom, 0)
    assert.equal(result.scanned, 1)
})
