import test from 'node:test'
import assert from 'node:assert/strict'
import { isRegistryItem, reduceRegistry } from './list-registry.mjs'
import { buildSharedSourceItem, reduceSharedSources } from './shared-source.mjs'

test('shared-source metadata is durable registry data but never a visible list', () => {
    const item = buildSharedSourceItem({
        baseKey: 'ab'.repeat(32),
        targetListId: 'list-shared',
        sourceListId: 'default',
        sourceListType: 'shopping',
        updatedAt: 5,
    })

    assert.equal(isRegistryItem(item), true)
    assert.deepEqual(reduceRegistry([item]), { groups: [], lists: [] })
    assert.deepEqual(reduceSharedSources([item]).get('ab'.repeat(32)), {
        baseKey: 'ab'.repeat(32),
        targetListId: 'list-shared',
        sourceListId: 'default',
        sourceListType: 'shopping',
    })
})
