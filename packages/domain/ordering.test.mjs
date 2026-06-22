import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    ORDER_STEP,
    orderOf,
    hasExplicitOrder,
    sortByOrder,
    orderBetween,
    renormalizeOrders,
    computeReorder,
} from './ordering.mjs'

function item (id, fields = {}) {
    return { id, text: id, isDone: false, timeOfCompletion: 0, updatedAt: 0, ...fields }
}

test('orderOf returns the numeric order or null', () => {
    assert.equal(orderOf(item('a', { order: 5 })), 5)
    assert.equal(orderOf(item('a', { order: 0 })), 0)
    assert.equal(orderOf(item('a')), null)
    assert.equal(orderOf(item('a', { order: NaN })), null)
    assert.equal(orderOf(item('a', { order: '3' })), null)
    assert.equal(orderOf(null), null)
})

test('hasExplicitOrder detects any ordered item', () => {
    assert.equal(hasExplicitOrder([item('a'), item('b')]), false)
    assert.equal(hasExplicitOrder([item('a'), item('b', { order: 1 })]), true)
    assert.equal(hasExplicitOrder([]), false)
})

test('sortByOrder leaves an unordered list untouched (insertion order)', () => {
    const items = [item('a'), item('b'), item('c')]
    assert.deepEqual(sortByOrder(items).map((i) => i.id), ['a', 'b', 'c'])
})

test('sortByOrder sorts explicit orders ascending', () => {
    const items = [item('a', { order: 30 }), item('b', { order: 10 }), item('c', { order: 20 })]
    assert.deepEqual(sortByOrder(items).map((i) => i.id), ['b', 'c', 'a'])
})

test('sortByOrder floats unordered items to the top in insertion order', () => {
    const items = [
        item('a', { order: 20 }),
        item('new1'),
        item('b', { order: 10 }),
        item('new2'),
    ]
    assert.deepEqual(sortByOrder(items).map((i) => i.id), ['new1', 'new2', 'b', 'a'])
})

test('sortByOrder is stable for equal orders', () => {
    const items = [item('a', { order: 5 }), item('b', { order: 5 }), item('c', { order: 5 })]
    assert.deepEqual(sortByOrder(items).map((i) => i.id), ['a', 'b', 'c'])
})

test('orderBetween returns a value strictly between neighbours', () => {
    assert.equal(orderBetween(10, 20), 15)
    assert.equal(orderBetween(null, 10), 10 - ORDER_STEP)
    assert.equal(orderBetween(10, null), 10 + ORDER_STEP)
    assert.equal(orderBetween(null, null), ORDER_STEP)
})

test('renormalizeOrders only rewrites items whose order changed', () => {
    const seq = [
        item('a', { order: ORDER_STEP }),       // already correct -> skipped
        item('b', { order: 999 }),              // wrong -> rewritten to 2*STEP
        item('c'),                              // missing -> rewritten to 3*STEP
    ]
    const updates = renormalizeOrders(seq)
    assert.deepEqual(updates.map((i) => [i.id, i.order]), [
        ['b', 2 * ORDER_STEP],
        ['c', 3 * ORDER_STEP],
    ])
})

test('computeReorder on a never-ordered list renormalizes the whole group once', () => {
    const items = [item('a'), item('b'), item('c'), item('d')]
    // move 'd' (index 3) to the top (index 0)
    const { updates, renormalized } = computeReorder(items, 3, 0)
    assert.equal(renormalized, true)
    // resulting sequence d,a,b,c gets evenly spaced orders
    assert.deepEqual(updates.map((i) => [i.id, i.order]), [
        ['d', 1 * ORDER_STEP],
        ['a', 2 * ORDER_STEP],
        ['b', 3 * ORDER_STEP],
        ['c', 4 * ORDER_STEP],
    ])
})

test('computeReorder on an ordered list is a single midpoint write', () => {
    const items = [
        item('a', { order: 1000 }),
        item('b', { order: 2000 }),
        item('c', { order: 3000 }),
        item('d', { order: 4000 }),
    ]
    // move 'd' between 'a' and 'b'
    const { updates, renormalized } = computeReorder(items, 3, 1)
    assert.equal(renormalized, false)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].id, 'd')
    assert.equal(updates[0].order, 1500)
})

test('computeReorder to the top sits below nothing', () => {
    const items = [item('a', { order: 1000 }), item('b', { order: 2000 }), item('c', { order: 3000 })]
    const { updates } = computeReorder(items, 2, 0) // c to top
    assert.equal(updates.length, 1)
    assert.equal(updates[0].id, 'c')
    assert.equal(updates[0].order, 1000 - ORDER_STEP)
})

test('computeReorder to the bottom sits above nothing', () => {
    const items = [item('a', { order: 1000 }), item('b', { order: 2000 }), item('c', { order: 3000 })]
    const { updates } = computeReorder(items, 0, 2) // a to bottom
    assert.equal(updates.length, 1)
    assert.equal(updates[0].id, 'a')
    assert.equal(updates[0].order, 3000 + ORDER_STEP)
})

test('computeReorder renormalizes when the midpoint gap collapses', () => {
    const items = [
        item('a', { order: 1 }),
        item('b', { order: 1 + 1e-9 }), // gap far below ORDER_MIN_GAP
        item('c', { order: 2 }),
    ]
    const { updates, renormalized } = computeReorder(items, 2, 1) // c between a and b
    assert.equal(renormalized, true)
    assert.ok(updates.length >= 1)
})

test('computeReorder is a no-op when destination equals source', () => {
    const items = [item('a', { order: 1000 }), item('b', { order: 2000 })]
    assert.deepEqual(computeReorder(items, 0, 0).updates, [])
})

test('computeReorder ignores out-of-range source index', () => {
    const items = [item('a'), item('b')]
    assert.deepEqual(computeReorder(items, 9, 0).updates, [])
})

test('a sequence of midpoint moves stays consistently sorted', () => {
    let items = [
        item('a', { order: 1000 }),
        item('b', { order: 2000 }),
        item('c', { order: 3000 }),
    ]
    const apply = (updates) => {
        const byId = new Map(updates.map((u) => [u.id, u]))
        items = sortByOrder(items.map((it) => byId.get(it.id) ?? it))
    }
    apply(computeReorder(items, 2, 0).updates) // c to top -> c,a,b
    assert.deepEqual(items.map((i) => i.id), ['c', 'a', 'b'])
    apply(computeReorder(items, 0, 2).updates) // c to bottom -> a,b,c
    assert.deepEqual(items.map((i) => i.id), ['a', 'b', 'c'])
})
