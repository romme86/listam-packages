import test from 'node:test'
import assert from 'node:assert/strict'
import { buildItemPlanEntry, buildListPlanEntry, reducePlan } from '@listam/domain/plan'
import {
    buildDefaultPlanMigrations,
    promotedDefaultListId,
    shapeDefaultPromotionItems,
} from './share-promotion.mjs'

test('default promotion selects only groceries and rewrites only listId', () => {
    const grocery = { id: 'g', listId: 'default', listType: 'shopping', text: 'Milk', updatedAt: 1 }
    const legacyGrocery = { id: 'legacy', listId: 'default', text: 'Bread', updatedAt: 1 }
    const blankTypeGrocery = { id: 'blank', listId: 'default', listType: '', text: 'Eggs', updatedAt: 1 }
    const todo = { id: 't', listId: 'default', listType: 'todo', text: 'Call', updatedAt: 1 }
    const named = { id: 'n', listId: 'named', listType: 'shopping', text: 'Bread', updatedAt: 1 }
    const shaped = shapeDefaultPromotionItems([grocery, legacyGrocery, blankTypeGrocery, todo, named], {
        sourceListId: 'default',
        sourceListType: 'shopping',
        targetListId: 'list-shared',
    })

    assert.deepEqual(shaped.source, [grocery, legacyGrocery, blankTypeGrocery])
    assert.deepEqual(shaped.seeded, [
        { ...grocery, listId: 'list-shared' },
        { ...legacyGrocery, listId: 'list-shared', listType: 'shopping' },
        { ...blankTypeGrocery, listId: 'list-shared', listType: 'shopping' },
    ])
    assert.equal(shaped.seeded[0].id, grocery.id)
})

test('canonical promoted id derives from the public shared base key', () => {
    assert.equal(promotedDefaultListId('ABCD'), 'list-abcd')
    assert.equal(promotedDefaultListId(''), null)
})

test('default promotion migrates matching item/list plan refs and leaves todo refs alone', () => {
    const itemPlan = buildItemPlanEntry({ listId: 'default', itemId: 'g', plannedFor: '2026-08-01', planOrder: 10, updatedAt: 1 })
    const listPlan = buildListPlanEntry({ listId: 'default', listType: 'shopping', plannedFor: '2026-08-02', planOrder: 20, updatedAt: 2 })
    const todoPlan = buildListPlanEntry({ listId: 'default', listType: 'todo', plannedFor: '2026-08-03', planOrder: 30, updatedAt: 3 })
    const migrations = buildDefaultPlanMigrations([itemPlan, listPlan, todoPlan], {
        sourceListId: 'default',
        sourceListType: 'shopping',
        sourceItemIds: new Set(['g']),
        targetListId: 'list-shared',
        updatedAt: 100,
    })

    assert.equal(migrations.length, 2)
    const reduced = reducePlan([
        itemPlan,
        listPlan,
        todoPlan,
        ...migrations.flatMap(({ add, clear }) => [add, clear]),
    ])
    assert.ok(reduced.has('i:list-shared::g'))
    assert.ok(reduced.has('l:list-shared::shopping'))
    assert.ok(reduced.has('l:default::todo'))
    assert.equal(reduced.has('i:default::g'), false)
    assert.equal(reduced.has('l:default::shopping'), false)
})
