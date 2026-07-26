import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutboxStore, OUTBOX_FILENAME } from './outbox-store.mjs'
import { BLOCKED_EPOCH_CHANGED } from './outbox.mjs'

function harness (t, over = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'listam-outbox-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const notices = []
    const replayed = []
    let clock = 1000
    const store = createOutboxStore({
        fs,
        storagePath: dir,
        now: () => clock,
        replayEntry: async (entry) => { replayed.push(entry.id); return true },
        currentEpoch: () => 3,
        baseKeyForList: () => null,
        notify: (event) => notices.push(event),
        ...over,
    })
    return { dir, store, notices, replayed, tick: (ms) => { clock += ms }, clockAt: () => clock }
}

const mutation = (id, over = {}) => ({ id, command: 7, payload: { text: 'Milk' }, listId: 'groceries', ...over })

test('a refused mutation is kept, not dropped', (t) => {
    const { store, dir, notices } = harness(t)
    store.queue(mutation('op-1'))

    assert.equal(store.size(), 1)
    assert.equal(fs.existsSync(join(dir, OUTBOX_FILENAME)), true, 'it must survive a crash')
    assert.equal(notices.at(-1).type, 'write-queued')
})

test('the queue survives a restart', (t) => {
    const { store, dir } = harness(t)
    store.queue(mutation('op-1'))
    store.queue(mutation('op-2'))

    // A brand-new store over the same directory: this is what boot does.
    const reopened = createOutboxStore({ fs, storagePath: dir, replayEntry: async () => true })
    assert.deepEqual(reopened.list().map((e) => e.id), ['op-1', 'op-2'])
})

test('replay drains the queue in order and clears it', async (t) => {
    const { store, replayed } = harness(t)
    store.queue(mutation('first'))
    store.queue(mutation('second'))

    const result = await store.replay()
    assert.deepEqual(replayed, ['first', 'second'], 'offline edits replay in the order made')
    assert.deepEqual(result, { replayed: 2, blocked: 0 })
    assert.equal(store.size(), 0)
})

test('a replay that fails KEEPS the entry and stops hammering the writer', async (t) => {
    const attempts = []
    const { store } = harness(t, {
        replayEntry: async (entry) => { attempts.push(entry.id); return false },
    })
    store.queue(mutation('a'))
    store.queue(mutation('b'))

    const result = await store.replay()
    assert.deepEqual(attempts, ['a'], 'stop after the first failure — the writer is down again')
    assert.equal(result.replayed, 0)
    assert.equal(store.size(), 2, 'nothing may be lost')
    assert.equal(store.list()[0].attempts, 1, 'the attempt is recorded so a stuck entry is visible')
})

test('a replay that throws is treated as failure, never as success', async (t) => {
    const { store } = harness(t, {
        replayEntry: async () => { throw new Error('writer exploded') },
    })
    store.queue(mutation('a'))
    await store.replay()
    assert.equal(store.size(), 1, 'an exception must not silently drop the queued edit')
})

test('an entry whose epoch rotated stays queued and asks the user', async (t) => {
    // Re-encrypting under the new epoch would silently republish content the
    // rotation may have been performed to revoke. Not ours to decide.
    const { store, notices, replayed } = harness(t, { currentEpoch: () => 3 })
    store.queue(mutation('stale'))

    // Same clock as the harness: with the real Date.now the entry (stamped at
    // 1000) would be reported as expired, which is true but not what is under
    // test here.
    const rotated = createOutboxStore({
        fs,
        storagePath: store.path.replace(`/${OUTBOX_FILENAME}`, ''),
        now: () => 2000,
        replayEntry: async (e) => { replayed.push(e.id); return true },
        currentEpoch: () => 9,
        baseKeyForList: () => null,
        notify: (event) => notices.push(event),
    })
    const result = await rotated.replay()

    assert.deepEqual(replayed, [], 'it must not replay')
    assert.equal(result.blocked, 1)
    assert.equal(rotated.size(), 1, 'and must not be discarded either')
    const decision = notices.find((n) => n.type === 'write-needs-decision')
    assert.ok(decision, 'the user has to be asked')
    assert.equal(decision.blocked[0].reason, BLOCKED_EPOCH_CHANGED)
})

test('replay is not re-entrant', async (t) => {
    let inFlight = 0
    let maxConcurrent = 0
    const { store } = harness(t, {
        replayEntry: async () => {
            inFlight++
            maxConcurrent = Math.max(maxConcurrent, inFlight)
            await new Promise((r) => setTimeout(r, 20))
            inFlight--
            return true
        },
    })
    store.queue(mutation('a'))
    store.queue(mutation('b'))

    await Promise.all([store.replay(), store.replay()])
    assert.equal(maxConcurrent, 1, 'two passes would append the same entry twice')
})

test('discard removes an entry the user rejected', (t) => {
    const { store } = harness(t)
    store.queue(mutation('a'))
    assert.equal(store.discard('a'), true)
    assert.equal(store.size(), 0)
    assert.equal(store.discard('a'), false, 'discarding twice is a no-op')
})

test('a corrupt outbox file starts empty instead of blocking boot', (t) => {
    const { store, dir } = harness(t)
    store.queue(mutation('a'))
    fs.writeFileSync(join(dir, OUTBOX_FILENAME), '{ not json')

    const reopened = createOutboxStore({ fs, storagePath: dir, replayEntry: async () => true })
    assert.deepEqual(reopened.list(), [])
})

test('replaying an empty queue is a cheap no-op', async (t) => {
    const { store, replayed } = harness(t)
    assert.deepEqual(await store.replay(), { replayed: 0, blocked: 0 })
    assert.deepEqual(replayed, [])
})
