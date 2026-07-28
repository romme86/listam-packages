// `baseKey` must never survive into a base.
//
// It is transport metadata the backend stamps on the way OUT so a client knows
// which base a row came from. A client that edits the row sends the whole item
// straight back, so without a strip at the write boundary it would be persisted
// — and then carrying that row into another list would file it, on every client,
// under a base that no longer owns it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareListAppendOperation } from './item.mjs'
import { createListOperation } from './list-reducer.mjs'

const row = (extra = {}) => ({
    id: 'x1', text: 'Milk', listId: 'shopping', listType: 'shopping',
    isDone: false, timeOfCompletion: 0, updatedAt: 1, ...extra,
})

// No epoch key on this view, so the op comes back in the clear and can be read.
const plain = { epochKey: null, membershipState: { currentEpoch: 0 } }

test('an echoed baseKey is stripped before the op is appended', () => {
    const op = createListOperation('add', row({ baseKey: 'deadbeef' }), { listId: 'shopping', listType: 'shopping' })
    assert.equal(op.value.baseKey, 'deadbeef', 'PRECONDITION: the client-supplied field survives normalization')

    const prepared = prepareListAppendOperation(op, plain)
    assert.equal('baseKey' in prepared.value, false, 'baseKey must not reach the base')
    assert.equal(prepared.value.id, 'x1', 'the rest of the item is untouched')
    assert.equal(prepared.value.text, 'Milk')
})

test('an op with no baseKey is passed through unchanged, by reference', () => {
    // The strip runs on every append, so it must not allocate when there is
    // nothing to strip.
    const op = createListOperation('add', row(), { listId: 'shopping', listType: 'shopping' })
    assert.equal(prepareListAppendOperation(op, plain), op)
})

test('every item of a bulk list op is stripped', () => {
    const op = createListOperation('list', [row({ baseKey: 'aa' }), row({ id: 'x2', baseKey: 'bb' })], {
        listId: 'shopping', listType: 'shopping',
    })
    const prepared = prepareListAppendOperation(op, plain)
    assert.deepEqual(prepared.value.map((i) => 'baseKey' in i), [false, false])
    assert.deepEqual(prepared.value.map((i) => i.id), ['x1', 'x2'])
})

test('a bulk list op with nothing to strip is passed through by reference', () => {
    const op = createListOperation('list', [row(), row({ id: 'x2' })], { listId: 'shopping', listType: 'shopping' })
    assert.equal(prepareListAppendOperation(op, plain), op)
})

test('a delete op is stripped too, so a tombstone carries no base', () => {
    const op = createListOperation('delete', row({ baseKey: 'deadbeef' }), { listId: 'shopping', listType: 'shopping' })
    const prepared = prepareListAppendOperation(op, plain)
    assert.equal('baseKey' in prepared.value, false)
})
