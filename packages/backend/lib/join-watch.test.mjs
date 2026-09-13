import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { waitForWritable, cancelJoinViaInvite } from './network.mjs'
import { setAutobase, setSwarm, setRpc, setIsPendingJoinSuccess, isPendingJoinSuccess } from './state.mjs'
import { logger } from './logger.mjs'

function setup(t, update = () => new Promise(() => {}), options = {}) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
    t.mock.method(logger, 'log', () => {})
    const base = Object.assign(new EventEmitter(), { view: { length: 0 }, writable: false, update })
    const swarm = Object.assign(new EventEmitter(), { connections: new Set() })
    const events = []
    setAutobase(base)
    setSwarm(swarm)
    setRpc({ request: () => ({ send: (payload) => events.push(JSON.parse(payload)) }) })
    setIsPendingJoinSuccess(true)
    t.after(() => {
        cancelJoinViaInvite()
        setIsPendingJoinSuccess(false)
        setAutobase(null)
        setSwarm(null)
        setRpc(null)
    })
    waitForWritable(options)
    function advance(ms) {
        // Tick each poll separately, as on the real event loop.
        for (let elapsed = 0; elapsed < ms; elapsed += 5000) t.mock.timers.tick(5000)
    }
    return { base, swarm, events, advance }
}

test('permission wait times out even when autobase.update never settles', (t) => {
    let updates = 0
    const { base, swarm, events, advance } = setup(t, () => {
        updates++
        return new Promise(() => {})
    })
    advance(115_000)
    assert.equal(isPendingJoinSuccess, true)
    assert.equal(events.filter(e => e.type === 'join-progress').length, 11)
    assert.equal(events.at(-1).phase, 'permission')
    advance(5000)
    assert.equal(isPendingJoinSuccess, false)
    assert.equal(updates, 1, 'polls must not accumulate blocked updates')
    assert.equal(events.filter(e => e.type === 'join-error').length, 1)
    assert.equal(events.find(e => e.type === 'join-error').reason, 'timeout')
    assert.equal(base.listenerCount('update'), 0)
    assert.equal(swarm.listenerCount('connection'), 0)
    advance(120_000)
    assert.equal(events.filter(e => e.type === 'join-error').length, 1)
})

test('a pending update with a progressing view can replay for over ten minutes', (t) => {
    const { base, events, advance } = setup(t)
    for (let i = 0; i < 130; i++) {
        base.view.length += 10
        advance(5000)
    }
    assert.equal(isPendingJoinSuccess, true)
    assert.equal(events.some(e => e.type === 'join-error'), false)
    advance(120_000)
    assert.equal(isPendingJoinSuccess, false, 'a later stall still expires')
})

test('permission cancellation detaches the watch while update is still pending', (t) => {
    const { base, swarm, events, advance } = setup(t)
    assert.equal(cancelJoinViaInvite(), true)
    assert.equal(isPendingJoinSuccess, false)
    assert.equal(events.find(e => e.type === 'join-error').reason, 'cancelled')
    const count = events.length
    advance(180_000)
    base.emit('update')
    swarm.emit('connection')
    assert.equal(events.length, count)
    assert.equal(cancelJoinViaInvite(), false)
})

test('writability is detected even if the update promise remains pending', (t) => {
    const { base, swarm, events, advance } = setup(t)
    base.writable = true
    swarm.connections.add({})
    advance(5000)
    assert.equal(isPendingJoinSuccess, false)
    assert.equal(events.filter(e => e.type === 'join-success').length, 1)
    assert.equal(events.some(e => e.type === 'join-error'), false)
})

test('late update completion after cancellation cannot project old project data', async (t) => {
    let resolve
    const { events } = setup(t, () => new Promise(r => { resolve = r }))
    cancelJoinViaInvite()
    const count = events.length
    resolve()
    await new Promise(r => setImmediate(r))
    assert.equal(events.length, count)
})

test('switching bases stops the old watch without emitting a timeout', (t) => {
    const { base, swarm, events, advance } = setup(t)
    setAutobase({})
    advance(180_000)
    assert.equal(events.some(e => e.type === 'join-error'), false)
    assert.equal(base.listenerCount('update'), 0)
    assert.equal(swarm.listenerCount('connection'), 0)
})

test('a stalled view read cannot block the permission timeout', async (t) => {
    const { base, events, advance } = setup(t, async () => {})
    let reads = 0
    base.view.length = 1
    base.view.get = () => { reads++; return new Promise(() => {}) }
    await new Promise(r => setImmediate(r))
    assert.ok(reads > 0, 'the projection must actually be blocked on a view read')
    advance(125_000)
    assert.equal(isPendingJoinSuccess, false)
    assert.equal(events.filter(e => e.type === 'join-error').length, 1)
})

test('a writable guest without a main connection finishes after the syncing grace period', (t) => {
    const { base, events, advance } = setup(t)
    advance(60_000)
    base.writable = true
    advance(5000)
    assert.ok(events.some(e => e.type === 'join-phase' && e.phase === 'syncing'))
    advance(115_000)
    assert.equal(isPendingJoinSuccess, true)
    advance(5000)
    assert.equal(isPendingJoinSuccess, false)
    assert.equal(events.filter(e => e.type === 'join-success').length, 1)
})

test('permission heartbeats retain elapsed pairing and initialization time', (t) => {
    const { events, advance } = setup(t, undefined, { startedAt: 960_000 })
    advance(10_000)
    assert.equal(events.find(e => e.type === 'join-progress').elapsedMs, 50_000)
})
