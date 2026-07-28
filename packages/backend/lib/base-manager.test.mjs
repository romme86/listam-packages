import test from 'node:test'
import assert from 'node:assert/strict'
import { createBaseContext, isPersonalContext } from './base-context.mjs'
import { createBaseManager, desiredSharedBaseKeys, SHARED_BASE_SWARM_ADVISORY } from './base-manager.mjs'

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

// --- swarm-count advisory (Release 3.2 spike) ------------------------------
//
// The spike declined to multiplex swarms because the live mesh had zero shared
// bases open — every device already runs exactly one swarm. This warning is what
// re-raises the question if that stops being true, instead of relying on someone
// remembering.

function advisoryHarness () {
    const lines = []
    const openShared = async (baseKey) => ({ baseKey })
    const manager = createBaseManager({
        openShared,
        closeShared: async () => {},
        logger: { log: (msg, details) => lines.push({ msg, details }) },
    })
    const registryOf = (n) => ({ lists: Array.from({ length: n }, (_, i) => ({ id: `l${i}`, baseKey: `base${i}` })) })
    return { manager, lines, registryOf }
}

test('no advisory while the number of shared bases stays at or below the threshold', async () => {
    const { manager, lines, registryOf } = advisoryHarness()
    await manager.reconcile(registryOf(SHARED_BASE_SWARM_ADVISORY))
    assert.equal(manager.shared.size, SHARED_BASE_SWARM_ADVISORY)
    assert.deepEqual(lines, [])
})

test('crossing the threshold warns once, with the count', async () => {
    const { manager, lines, registryOf } = advisoryHarness()
    await manager.reconcile(registryOf(SHARED_BASE_SWARM_ADVISORY + 1))
    assert.equal(lines.length, 1, 'crossing the threshold must warn')
    assert.match(lines[0].msg, /swarm multiplexing/)
    assert.equal(lines[0].details.openSharedBases, SHARED_BASE_SWARM_ADVISORY + 1)

    // Reconciling again must not repeat it — this is a nudge, not a log spammer.
    await manager.reconcile(registryOf(SHARED_BASE_SWARM_ADVISORY + 2))
    assert.equal(lines.length, 1, 'the advisory is one-shot')
})

test('the manager works with no logger injected', async () => {
    // Every existing caller constructs it without one.
    const manager = createBaseManager({ openShared: async (k) => ({ k }), closeShared: async () => {} })
    const lists = Array.from({ length: SHARED_BASE_SWARM_ADVISORY + 1 }, (_, i) => ({ id: `l${i}`, baseKey: `b${i}` }))
    await manager.reconcile({ lists })
    assert.equal(manager.shared.size, SHARED_BASE_SWARM_ADVISORY + 1)
})
