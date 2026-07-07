import test from 'node:test'
import assert from 'node:assert/strict'
import {
    PLAN_LIST_ID,
    PLAN_LIST_TYPE,
    PLAN_KIND_ITEM,
    PLAN_KIND_LIST,
    isPlanItem,
    planItemKey,
    planListKey,
    toDateKey,
    shiftDateKey,
    isPastDateKey,
    overduePlanRecords,
    buildPlanItem,
    buildItemPlanEntry,
    buildListPlanEntry,
    reducePlan,
    groupPlanByDate,
    computePlanReorder,
} from './plan.mjs'
import { normalizeListItem } from './list-reducer.mjs'
import { isRegistryItem } from './list-registry.mjs'
import { isLabelItem } from './labels.mjs'

test('buildItemPlanEntry produces a well-shaped, validator-safe pointer', () => {
    const it = buildItemPlanEntry({ listId: 'default', itemId: 'abc', plannedFor: '2026-06-22', planOrder: 1000, updatedAt: 7 })
    assert.equal(it.id, 'i:default::abc')
    assert.equal(it.listId, PLAN_LIST_ID)
    assert.equal(it.listType, PLAN_LIST_TYPE)
    assert.equal(it.planKind, PLAN_KIND_ITEM)
    assert.equal(it.planRefListId, 'default')
    assert.equal(it.planRefItemId, 'abc')
    assert.equal(it.plannedFor, '2026-06-22')
    assert.equal(it.planOrder, 1000)
    assert.equal(it.isDone, false)
    assert.equal(it.timeOfCompletion, 0)
    assert.equal(it.updatedAt, 7)
    assert.equal(isPlanItem(it), true)
    // Not mistaken for, nor mistaking, the other meta channels.
    assert.equal(isRegistryItem(it), false)
    assert.equal(isLabelItem(it), false)
})

test('buildListPlanEntry refs a whole list, keyed by (listId, type)', () => {
    const it = buildListPlanEntry({ listId: 'shop1', listType: 'shopping', plannedFor: '2026-06-23', planOrder: 5, updatedAt: 2 })
    assert.equal(it.id, 'l:shop1::shopping')
    assert.equal(it.planKind, PLAN_KIND_LIST)
    assert.equal(it.planRefListId, 'shop1')
    assert.equal(it.planRefType, 'shopping')
    // Built-in surfaces share listId 'default' but differ by type.
    const groceries = buildListPlanEntry({ listId: 'default', listType: 'shopping', plannedFor: '2026-06-22', updatedAt: 1 })
    const todo = buildListPlanEntry({ listId: 'default', listType: 'todo', plannedFor: '2026-06-22', updatedAt: 1 })
    assert.notEqual(groceries.id, todo.id)
})

test('plan items survive the strict reducer normalizer (so old peers accept them)', () => {
    const it = buildItemPlanEntry({ listId: 'default', itemId: 'x', plannedFor: '2026-06-22', updatedAt: 1 })
    const norm = normalizeListItem(it)
    assert.ok(norm)
    assert.equal(norm.id, 'i:default::x')
    assert.equal(norm.listId, PLAN_LIST_ID)
    assert.equal(norm.plannedFor, '2026-06-22')
})

test('planItemKey / planListKey are stable and id-forming', () => {
    assert.equal(planItemKey('default', 'abc'), 'i:default::abc')
    assert.equal(planListKey('shop1'), 'l:shop1')
    assert.equal(planListKey('default', 'todo'), 'l:default::todo')
})

test('reducePlan keeps newest by updatedAt per ref', () => {
    const items = [
        buildItemPlanEntry({ listId: 'default', itemId: 'a', plannedFor: '2026-06-22', planOrder: 1, updatedAt: 1 }),
        buildItemPlanEntry({ listId: 'default', itemId: 'a', plannedFor: '2026-06-24', planOrder: 1, updatedAt: 5 }),
        buildItemPlanEntry({ listId: 'default', itemId: 'b', plannedFor: '2026-06-22', planOrder: 2, updatedAt: 3 }),
        { id: 'noise', text: 'milk', isDone: false, timeOfCompletion: 0, listType: 'shopping' },
    ]
    const map = reducePlan(items)
    assert.equal(map.size, 2)
    assert.equal(map.get('i:default::a').plannedFor, '2026-06-24')
    assert.equal(map.get('i:default::b').plannedFor, '2026-06-22')
})

test('an empty plannedFor clears the plan entry (no tombstone needed)', () => {
    const items = [
        buildItemPlanEntry({ listId: 'default', itemId: 'a', plannedFor: '2026-06-22', updatedAt: 1 }),
        buildItemPlanEntry({ listId: 'default', itemId: 'a', plannedFor: '', updatedAt: 9 }),
    ]
    assert.equal(reducePlan(items).has('i:default::a'), false)
})

test('an older empty entry does not clear a newer plan', () => {
    const items = [
        buildItemPlanEntry({ listId: 'default', itemId: 'a', plannedFor: '', updatedAt: 9 }),
        buildItemPlanEntry({ listId: 'default', itemId: 'a', plannedFor: '2026-06-22', updatedAt: 10 }),
    ]
    assert.equal(reducePlan(items).get('i:default::a').plannedFor, '2026-06-22')
})

test('groupPlanByDate buckets by day and sorts each by planOrder', () => {
    const items = [
        buildItemPlanEntry({ listId: 'default', itemId: 'a', plannedFor: '2026-06-22', planOrder: 2000, updatedAt: 1 }),
        buildItemPlanEntry({ listId: 'default', itemId: 'b', plannedFor: '2026-06-22', planOrder: 1000, updatedAt: 1 }),
        buildListPlanEntry({ listId: 'shop1', plannedFor: '2026-06-23', planOrder: 1000, updatedAt: 1 }),
    ]
    const byDate = groupPlanByDate(reducePlan(items))
    assert.deepEqual(byDate.get('2026-06-22').map((r) => r.ref), ['i:default::b', 'i:default::a'])
    assert.equal(byDate.get('2026-06-23')[0].ref, 'l:shop1')
})

test('computePlanReorder moves a record and returns planOrder writes', () => {
    const day = groupPlanByDate(reducePlan([
        buildItemPlanEntry({ listId: 'd', itemId: 'a', plannedFor: '2026-06-22', planOrder: 1000, updatedAt: 1 }),
        buildItemPlanEntry({ listId: 'd', itemId: 'b', plannedFor: '2026-06-22', planOrder: 2000, updatedAt: 1 }),
        buildItemPlanEntry({ listId: 'd', itemId: 'c', plannedFor: '2026-06-22', planOrder: 3000, updatedAt: 1 }),
    ])).get('2026-06-22')
    // Move 'c' (index 2) to the top (index 0).
    const { updates } = computePlanReorder(day, 2, 0)
    assert.ok(updates.length >= 1)
    assert.equal(updates[0].ref, 'i:d::c')
    assert.ok(updates[0].planOrder < 1000)
})

test('toDateKey / shiftDateKey are pure and consistent', () => {
    const base = new Date(2026, 5, 22, 13, 0, 0).getTime() // local 2026-06-22
    assert.equal(toDateKey(base), '2026-06-22')
    assert.equal(shiftDateKey('2026-06-22', 1), '2026-06-23')
    assert.equal(shiftDateKey('2026-06-30', 1), '2026-07-01')
    assert.equal(shiftDateKey('2026-06-22', -1), '2026-06-21') // paging into the past
    assert.equal(shiftDateKey('bad', 1), '')
})

test('isPastDateKey compares zero-padded keys as strings, guarding format', () => {
    assert.equal(isPastDateKey('2026-06-21', '2026-06-22'), true)
    assert.equal(isPastDateKey('2026-06-22', '2026-06-22'), false) // today is not past
    assert.equal(isPastDateKey('2026-06-23', '2026-06-22'), false) // future
    assert.equal(isPastDateKey('2025-12-31', '2026-01-01'), true) // year rollover
    assert.equal(isPastDateKey('', '2026-06-22'), false) // cleared entry never overdue
    assert.equal(isPastDateKey('2026-06-21', 'bad'), false)
})

test('overduePlanRecords carries past-day entries, oldest-and-lowest-order first', () => {
    const items = [
        buildItemPlanEntry({ listId: 'd', itemId: 'today', plannedFor: '2026-06-22', planOrder: 1000, updatedAt: 1 }),
        buildItemPlanEntry({ listId: 'd', itemId: 'future', plannedFor: '2026-06-25', planOrder: 1000, updatedAt: 1 }),
        buildItemPlanEntry({ listId: 'd', itemId: 'yA', plannedFor: '2026-06-21', planOrder: 2000, updatedAt: 1 }),
        buildItemPlanEntry({ listId: 'd', itemId: 'yB', plannedFor: '2026-06-21', planOrder: 1000, updatedAt: 1 }),
        buildItemPlanEntry({ listId: 'd', itemId: 'old', plannedFor: '2026-06-19', planOrder: 1000, updatedAt: 1 }),
    ]
    const overdue = overduePlanRecords(reducePlan(items), '2026-06-22')
    // Only the three past-day refs, and not today's / the future's.
    assert.deepEqual(overdue.map((r) => r.refItemId), ['old', 'yB', 'yA'])
})

test('overduePlanRecords accepts a raw record array and ignores cleared entries', () => {
    // A newest-but-empty entry is already dropped by reducePlan; passing the
    // reduced map (not raw items) means cleared refs never appear as overdue.
    const items = [
        buildItemPlanEntry({ listId: 'd', itemId: 'a', plannedFor: '2026-06-20', updatedAt: 1 }),
        buildItemPlanEntry({ listId: 'd', itemId: 'a', plannedFor: '', updatedAt: 9 }),
    ]
    assert.deepEqual(overduePlanRecords(reducePlan(items), '2026-06-22'), [])
})
