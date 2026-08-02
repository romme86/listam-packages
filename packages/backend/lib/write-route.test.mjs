import test from 'node:test'
import assert from 'node:assert/strict'
import { settlesWithin, writeRouteAfterReconcile } from './write-route.mjs'

test('a route removed by reconciliation becomes a personal-base write', () => {
    assert.deepEqual(writeRouteAfterReconcile({
        mappedBefore: 'old-shared-base',
        requestedKey: 'old-shared-base',
        mappedAfter: null,
    }), { personal: true, key: null })
})

test('a refreshed registry route wins, while an explicit-only hint remains a hint', () => {
    assert.deepEqual(writeRouteAfterReconcile({
        mappedBefore: 'old-shared-base',
        requestedKey: 'old-shared-base',
        mappedAfter: 'new-shared-base',
    }), { personal: false, key: 'new-shared-base' })
    assert.deepEqual(writeRouteAfterReconcile({
        requestedKey: 'ui-shared-base',
    }), { personal: false, key: 'ui-shared-base' })
})

test('route recovery stops waiting at its deadline', async () => {
    const startedAt = Date.now()
    assert.equal(await settlesWithin(new Promise(() => {}), 20), false)
    assert.ok(Date.now() - startedAt < 250)
})
