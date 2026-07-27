// The seam between the write path and the outbox.
//
// Queue semantics are covered by outbox.test.mjs / outbox-store.test.mjs; this
// covers the injection points item.mjs exposes, which are what make the queue
// reachable at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import { replayQueuedOperation, setOutbox, tryReplayOutbox } from './item.mjs'

test.afterEach(() => setOutbox(null))

test('tryReplayOutbox is a no-op with no outbox installed', () => {
    setOutbox(null)
    assert.doesNotThrow(() => tryReplayOutbox())
})

test('tryReplayOutbox delegates to the installed store', async () => {
    let calls = 0
    setOutbox({ replay: async () => { calls++; return { replayed: 0, blocked: 0 } } })
    tryReplayOutbox()
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(calls, 1)
})

test('a replay that rejects is contained, never surfaced as an unhandled rejection', async () => {
    // This runs from a swarm connection handler; an unhandled rejection there
    // would take down the backend.
    setOutbox({ replay: async () => { throw new Error('boom') } })
    assert.doesNotThrow(() => tryReplayOutbox())
    await new Promise((r) => setTimeout(r, 10))
})

test('replaying a malformed entry fails cleanly instead of appending nonsense', async () => {
    for (const entry of [null, undefined, {}, { payload: null }, { payload: {} }]) {
        assert.equal(await replayQueuedOperation(entry), false, JSON.stringify(entry) ?? 'undefined')
    }
})
