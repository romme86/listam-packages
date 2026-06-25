import assert from 'node:assert/strict'
import test from 'node:test'
import { planOrphanedListHeals, tombstonedFromLog } from './orphan-heal.mjs'

const never = () => false
const none = () => []
const zero = () => 0

function baseInputs (overrides = {}) {
    return {
        lists: [{ id: 'default', name: 'Spesa coop', type: 'shopping', groupId: 'general', order: 0, baseKey: 'e2cf' }],
        isBaseOpen: never,
        hasCreds: never,
        hasLocalDir: never,
        isHealed: never,
        liveCount: zero,
        tombstoned: (id) => (id === 'default' ? [{ id: 'a', listId: 'default', listType: 'shopping', text: 'Pollo' }] : []),
        ...overrides,
    }
}

test('plans a heal for a fully-orphaned, all-tombstoned shared list', () => {
    const plans = planOrphanedListHeals(baseInputs())
    assert.equal(plans.length, 1)
    assert.equal(plans[0].listId, 'default')
    assert.equal(plans[0].baseKey, 'e2cf')
    assert.equal(plans[0].items.length, 1)
    assert.equal(plans[0].items[0].text, 'Pollo')
})

test('skips a list with no shared baseKey (a normal personal list)', () => {
    const plans = planOrphanedListHeals(baseInputs({ lists: [{ id: 'default', name: 'x', type: 'shopping', baseKey: null }] }))
    assert.equal(plans.length, 0)
})

test('skips when the shared base is OPEN (healthy)', () => {
    const plans = planOrphanedListHeals(baseInputs({ isBaseOpen: (k) => k === 'e2cf' }))
    assert.equal(plans.length, 0)
})

test('skips when propagated creds exist (cross-device auto-join in flight)', () => {
    const plans = planOrphanedListHeals(baseInputs({ hasCreds: (k) => k === 'e2cf' }))
    assert.equal(plans.length, 0)
})

test('skips when a local shared-storage dir exists', () => {
    const plans = planOrphanedListHeals(baseInputs({ hasLocalDir: (k) => k === 'e2cf' }))
    assert.equal(plans.length, 0)
})

test('skips an already-healed base (idempotent across boots)', () => {
    const plans = planOrphanedListHeals(baseInputs({ isHealed: (k) => k === 'e2cf' }))
    assert.equal(plans.length, 0)
})

test('skips when the list still has live items (data not stranded)', () => {
    const plans = planOrphanedListHeals(baseInputs({ liveCount: (id) => (id === 'default' ? 3 : 0) }))
    assert.equal(plans.length, 0)
})

test('skips when there is nothing recoverable', () => {
    const plans = planOrphanedListHeals(baseInputs({ tombstoned: none }))
    assert.equal(plans.length, 0)
})

test('ignores tombstoned items without text (e.g. malformed)', () => {
    const plans = planOrphanedListHeals(baseInputs({
        tombstoned: () => [{ id: 'a', listId: 'default', listType: 'shopping' }],
    }))
    assert.equal(plans.length, 0)
})

test('tombstonedFromLog recovers add-then-delete items with full payload', () => {
    const log = [
        { op: 'add', id: 'a', listId: 'default', listType: 'shopping', text: 'Pollo', isDone: false },
        { op: 'add', id: 'b', listId: 'default', listType: 'kanban', text: 'Job', status: 'todo' },
        { op: 'update', id: 'a', listId: 'default', listType: 'shopping', text: 'Pollo arrosto', isDone: true },
        { op: 'delete', id: 'a', listId: 'default', listType: 'shopping', item: { id: 'a', listId: 'default', listType: 'shopping', text: 'Pollo arrosto' } },
        { op: 'delete', id: 'b', listId: 'default', listType: 'kanban', item: { id: 'b', listId: 'default', listType: 'kanban', text: 'Job', status: 'todo' } },
    ]
    const tomb = tombstonedFromLog(log)
    const def = tomb.get('default')
    assert.ok(def)
    assert.equal(def.size, 2)
    // Latest add/update payload is preserved (text/isDone from the update).
    assert.equal(def.get('a').text, 'Pollo arrosto')
    assert.equal(def.get('a').isDone, true)
    assert.equal(def.get('b').status, 'todo')
})

test('tombstonedFromLog excludes items resurrected after deletion', () => {
    const log = [
        { op: 'add', id: 'a', listId: 'default', listType: 'shopping', text: 'Pollo' },
        { op: 'delete', id: 'a', listId: 'default', listType: 'shopping', item: { id: 'a', listId: 'default', text: 'Pollo' } },
        { op: 'update', id: 'a', listId: 'default', listType: 'shopping', text: 'Pollo' }, // re-added
    ]
    const tomb = tombstonedFromLog(log)
    assert.equal(tomb.has('default'), false)
})

test('tombstonedFromLog ignores membership / board-config control entries', () => {
    const log = [
        { op: 'membership', record: {} },
        { op: 'board-config', record: {} },
        { op: 'add', id: 'a', listId: 'default', listType: 'shopping', text: 'x' },
        { op: 'delete', id: 'a', listId: 'default', listType: 'shopping', item: { id: 'a', listId: 'default', text: 'x' } },
    ]
    const tomb = tombstonedFromLog(log)
    assert.equal(tomb.get('default').size, 1)
})
