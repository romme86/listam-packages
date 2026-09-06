import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackendActivity } from './backend-activity.mjs'
import { createSleepCoordinator } from './sleep-coordinator.mjs'
import { createSwarmLifecycle } from './swarm-lifecycle.mjs'

function setup(bases = [], timeoutMs = 80) {
    const activity = createBackendActivity()
    const swarm = { suspended: false, async suspend() { this.suspended = true }, async resume() { this.suspended = false } }
    const network = createSwarmLifecycle({ getSwarms: () => [swarm], timeoutMs })
    const coordinator = createSleepCoordinator({ activity, getBases: () => bases, timeoutMs,
        suspendNetwork: network.suspend, resumeNetwork: network.resume, networkSnapshot: network.snapshot })
    return { activity, coordinator, swarm }
}

test('sleep waits for queued writes and database flush, then reports drained', async () => {
    let flushed = false
    const { activity, coordinator } = setup([{ async advance() {}, async flush() { flushed = true } }])
    const done = activity.begin()
    const sleeping = coordinator.suspend()
    await new Promise((r) => setImmediate(r))
    assert.equal(flushed, false)
    done()
    assert.deepEqual(await sleeping, { safeToSleep: true, reason: 'drained', suspended: true })
    assert.equal(flushed, true)
    assert.equal(activity.snapshot().pending, 0)
})

test('one unavailable base cannot stop another draining, and the common deadline is hard', async () => {
    let reachableFlushed = false
    const { coordinator } = setup([
        { advance: () => new Promise(() => {}), async flush() {} },
        { async advance() {}, async flush() { reachableFlushed = true } },
    ], 25)
    const start = Date.now()
    const result = await coordinator.suspend()
    assert.equal(result.safeToSleep, false)
    assert.equal(result.reason, 'deadline')
    assert.equal(reachableFlushed, true)
    assert.ok(Date.now() - start < 300)
})

test('a foreground return supersedes a pending sleep and cannot be overwritten by its late reply', async () => {
    const { activity, coordinator, swarm } = setup()
    const done = activity.begin()
    const sleeping = coordinator.suspend()
    await coordinator.resume()
    done()
    assert.equal((await sleeping).safeToSleep, false)
    assert.equal(swarm.suspended, false)
    assert.equal(coordinator.snapshot().reason, 'active')
})

test('100 rapid cycles leave no pending activity or suspended foreground sockets', async () => {
    const { activity, coordinator, swarm } = setup()
    for (let i = 0; i < 100; i++) {
        const done = activity.begin()
        const sleeping = coordinator.suspend()
        await coordinator.resume()
        done()
        assert.equal((await sleeping).safeToSleep, false)
    }
    assert.equal(swarm.suspended, false)
    assert.equal(activity.snapshot().pending, 0)
})

test('work arriving during a flush requires another drain before sleep', async () => {
    let calls = 0, activity
    const base = { async advance() {}, async flush() {
        if (++calls === 1) { const done = activity.begin(); queueMicrotask(done) }
    } }
    const runtime = setup([base]); activity = runtime.activity
    assert.equal((await runtime.coordinator.suspend()).safeToSleep, true)
    assert.equal(calls, 2)
})

test('diagnostics revoke the sleep signal immediately when new application work arrives', async () => {
    const { activity, coordinator } = setup()
    assert.equal((await coordinator.suspend()).safeToSleep, true)
    const done = activity.begin()
    assert.equal(coordinator.snapshot().safeToSleep, false)
    assert.equal(coordinator.snapshot().pending, 1)
    done()
    assert.equal(coordinator.snapshot().safeToSleep, false, 'new work must pass through another database drain')
    assert.equal((await coordinator.suspend()).safeToSleep, true)
})
