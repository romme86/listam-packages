import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmLifecycle } from './swarm-lifecycle.mjs'

function fakeSwarm() {
    return {
        suspended: false,
        calls: [],
        async suspend() { this.calls.push('suspend'); this.suspended = true },
        async resume() { this.calls.push('resume'); this.suspended = false },
    }
}

test('100 lifecycle cycles suspend and resume every personal, shared and pairing swarm', async () => {
    const swarms = Array.from({ length: 4 }, fakeSwarm)
    const lifecycle = createSwarmLifecycle({ getSwarms: () => [...swarms, swarms[0], null] })
    for (let i = 0; i < 100; i++) {
        assert.equal(await lifecycle.suspend(), true)
        assert.ok(swarms.every((s) => s.suspended))
        assert.equal(await lifecycle.resume(), true)
        assert.ok(swarms.every((s) => !s.suspended))
    }
    for (const s of swarms) assert.equal(s.calls.length, 200)
})

test('a resume waits for an in-flight suspend even after the request deadline', async () => {
    const swarm = fakeSwarm()
    let finish
    swarm.suspend = async () => {
        swarm.calls.push('suspending')
        swarm.suspended = true // Hyperswarm sets this before its awaits finish.
        await new Promise((resolve) => { finish = resolve })
        swarm.calls.push('suspended')
    }
    const other = fakeSwarm()
    const lifecycle = createSwarmLifecycle({ getSwarms: () => [swarm, other], timeoutMs: 20 })
    assert.equal(await lifecycle.suspend(), false)
    assert.equal(other.suspended, true)
    const resumed = lifecycle.resume()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(other.suspended, false, 'a slow swarm does not block the reachable base')
    assert.deepEqual(swarm.calls, ['suspending'])
    finish()
    assert.equal(await resumed, true)
    assert.deepEqual(swarm.calls, ['suspending', 'suspended', 'resume'])
})

test('repeated requests coalesce and destroyed swarms are ignored', async () => {
    const s = fakeSwarm()
    const dead = { destroyed: true }
    const lifecycle = createSwarmLifecycle({ getSwarms: () => [s, dead] })
    await Promise.all(Array.from({ length: 100 }, () => lifecycle.suspend()))
    assert.deepEqual(s.calls, ['suspend'])
    await lifecycle.resume()
    assert.deepEqual(s.calls, ['suspend', 'resume'])
})

test('a swarm opened during suspension joins the same drain and stays paused', async () => {
    const first = fakeSwarm(), late = fakeSwarm()
    let finish
    first.suspend = async () => { await new Promise((r) => { finish = r }); first.suspended = true }
    const lifecycle = createSwarmLifecycle({ getSwarms: () => [first] })
    const pausing = lifecycle.suspend()
    await new Promise((r) => setImmediate(r))
    lifecycle.register(late)
    finish()
    assert.equal(await pausing, true)
    assert.equal(lifecycle.snapshot().allSuspended, true)
    assert.equal(late.suspended, true)
    const later = fakeSwarm()
    lifecycle.register(later)
    await new Promise((r) => setImmediate(r))
    assert.equal(later.suspended, true)
    assert.equal(await lifecycle.resume(), true)
    assert.equal(later.suspended, false)
    assert.equal(late.suspended, false)
})

test('a superseded suspend never reports successful suspension', async () => {
    const swarm = fakeSwarm()
    const lifecycle = createSwarmLifecycle({ getSwarms: () => [swarm] })
    const paused = lifecycle.suspend()
    const resumed = lifecycle.resume()
    assert.equal(await paused, false)
    assert.equal(await resumed, true)
    assert.equal(swarm.suspended, false)
})
