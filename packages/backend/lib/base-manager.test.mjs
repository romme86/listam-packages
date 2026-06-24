import test from 'node:test'
import assert from 'node:assert/strict'
import { createBaseContext, isPersonalContext } from './base-context.mjs'
import { createBaseManager, desiredSharedBaseKeys } from './base-manager.mjs'

test('createBaseContext gives each base independent state', () => {
    const a = createBaseContext({ role: 'shared', baseId: 'a', baseKey: 'aa' })
    const b = createBaseContext({ baseId: 'b' })
    assert.equal(a.role, 'shared')
    assert.equal(a.baseKey, 'aa')
    assert.equal(isPersonalContext(createBaseContext({ role: 'personal' })), true)
    assert.equal(isPersonalContext(a), false)

    // Collections must NOT be shared between contexts.
    a.knownWriters.add('x')
    a.membershipState.writers.add('w')
    a.currentList.push(1)
    assert.equal(b.knownWriters.has('x'), false)
    assert.equal(b.membershipState.writers.size, 0)
    assert.deepEqual(b.currentList, [])
})

test('desiredSharedBaseKeys extracts non-null baseKeys from a reduced registry', () => {
    const reg = { lists: [{ id: 'p', baseKey: null }, { id: 's1', baseKey: 'k1' }, { id: 's2', baseKey: 'k2' }, { id: 'x' }] }
    assert.deepEqual([...desiredSharedBaseKeys(reg)].sort(), ['k1', 'k2'])
    assert.deepEqual([...desiredSharedBaseKeys(null)], [])
})

test('base manager reconcile opens desired + closes removed (registry-driven auto-join)', async () => {
    const opened = []
    const closed = []
    const mgr = createBaseManager({
        openShared: async (k) => { opened.push(k); return createBaseContext({ role: 'shared', baseId: k, baseKey: k }) },
        closeShared: async (k) => { closed.push(k) },
    })

    let r = await mgr.reconcile({ lists: [{ baseKey: 'k1' }, { baseKey: 'k2' }] })
    assert.deepEqual(r.opened.sort(), ['k1', 'k2'])
    assert.deepEqual(mgr.keys().sort(), ['k1', 'k2'])

    // k2 dropped from the registry, k3 added → close k2, open k3.
    r = await mgr.reconcile({ lists: [{ baseKey: 'k1' }, { baseKey: 'k3' }] })
    assert.deepEqual(r.opened, ['k3'])
    assert.deepEqual(r.closed, ['k2'])
    assert.deepEqual(mgr.keys().sort(), ['k1', 'k3'])

    // Idempotent: the same registry makes no changes.
    r = await mgr.reconcile({ lists: [{ baseKey: 'k1' }, { baseKey: 'k3' }] })
    assert.deepEqual(r.opened, [])
    assert.deepEqual(r.closed, [])
})
