import test from 'node:test'
import assert from 'node:assert/strict'
import {
    BLOCKED_BASE_CHANGED,
    BLOCKED_EPOCH_CHANGED,
    BLOCKED_EXPIRED,
    DEFAULT_MAX_AGE_MS,
    checkPreconditions,
    createOutboxEntry,
    deserialize,
    enqueue,
    noteAttempt,
    planReplay,
    removeEntry,
    serialize,
} from './outbox.mjs'

const entry = (over = {}) => createOutboxEntry({
    id: 'op-1',
    command: 7,
    payload: { text: 'Milk' },
    listId: 'groceries',
    baseKey: null,
    epoch: 3,
    now: 1000,
    ...over,
})

test('an entry captures the world it was made in', () => {
    const e = entry()
    assert.equal(e.epoch, 3)
    assert.equal(e.baseKey, null)
    assert.equal(e.listId, 'groceries')
    assert.equal(e.createdAt, 1000)
    assert.equal(e.attempts, 0)
})

test('an entry without an id or command is refused outright', () => {
    assert.throws(() => createOutboxEntry({ command: 1 }), /id/)
    assert.throws(() => createOutboxEntry({ id: 'x' }), /command/)
})

test('enqueue de-duplicates by id so repeated offline edits converge', () => {
    // Editing one row five times offline must replay ONE write with the final
    // text. The reducer is LWW by id, so the earlier ones could only ever be
    // overwritten — replaying them wastes appends and flashes stale text.
    let q = []
    for (const text of ['a', 'b', 'c']) {
        q = enqueue(q, entry({ payload: { text }, now: 1000 }))
    }
    assert.equal(q.length, 1)
    assert.deepEqual(q[0].payload, { text: 'c' })
})

test('distinct ids all queue, in insertion order', () => {
    let q = []
    q = enqueue(q, entry({ id: 'a', now: 1 }))
    q = enqueue(q, entry({ id: 'b', now: 2 }))
    assert.deepEqual(q.map((e) => e.id), ['a', 'b'])
})

test('a runaway queue is trimmed OLDEST first', () => {
    let q = []
    for (let i = 0; i < 5; i++) q = enqueue(q, entry({ id: `op-${i}`, now: i }), { maxEntries: 3 })
    assert.deepEqual(q.map((e) => e.id), ['op-2', 'op-3', 'op-4'], 'the newest edits are the ones still wanted')
})

test('removeEntry drops exactly one entry', () => {
    const q = enqueue(enqueue([], entry({ id: 'a' })), entry({ id: 'b' }))
    assert.deepEqual(removeEntry(q, 'a').map((e) => e.id), ['b'])
})

test('an unchanged world replays', () => {
    assert.deepEqual(
        checkPreconditions(entry(), { epoch: 3, baseKeyForList: null, now: 2000 }),
        { ok: true },
    )
})

test('an epoch rotation BLOCKS replay', () => {
    // The list was re-keyed. The queued op is encrypted under the old epoch so
    // peers cannot read it, and re-encrypting under the new one would silently
    // republish content the rotation may have been performed to revoke.
    const result = checkPreconditions(entry(), { epoch: 4, baseKeyForList: null, now: 2000 })
    assert.deepEqual(result, { ok: false, reason: BLOCKED_EPOCH_CHANGED })
})

test('a list that moved base BLOCKS replay', () => {
    const result = checkPreconditions(entry(), { epoch: 3, baseKeyForList: 'abc123', now: 2000 })
    assert.deepEqual(result, { ok: false, reason: BLOCKED_BASE_CHANGED })
})

test('an unknown current base does NOT block — the registry may not have loaded', () => {
    assert.deepEqual(checkPreconditions(entry(), { epoch: 3, now: 2000 }), { ok: true })
})

test('a stale entry expires rather than replaying', () => {
    const result = checkPreconditions(entry(), {
        epoch: 3,
        baseKeyForList: null,
        now: 1000 + DEFAULT_MAX_AGE_MS + 1,
    })
    assert.deepEqual(result, { ok: false, reason: BLOCKED_EXPIRED })
})

test('an entry with no recorded epoch is not blocked by the current one', () => {
    // Older persisted entries, written before epochs were recorded.
    const e = entry({ epoch: null })
    assert.deepEqual(checkPreconditions(e, { epoch: 9, baseKeyForList: null, now: 2000 }), { ok: true })
})

test('planReplay separates ready from blocked and orders by creation', () => {
    const q = [
        entry({ id: 'late', now: 300 }),
        entry({ id: 'early', now: 100 }),
        entry({ id: 'rotated', now: 200, epoch: 99 }),
    ]
    const { ready, blocked } = planReplay(q, { epoch: 3, resolveBaseKeyForList: () => null, now: 400 })

    assert.deepEqual(ready.map((e) => e.id), ['early', 'late'], 'offline edits replay in the order made')
    assert.deepEqual(blocked.map((b) => ({ id: b.entry.id, reason: b.reason })), [
        { id: 'rotated', reason: BLOCKED_EPOCH_CHANGED },
    ])
})

test('planReplay resolves the current base PER LIST', () => {
    const q = [
        entry({ id: 'stays', listId: 'groceries', now: 1 }),
        entry({ id: 'moved', listId: 'holiday', now: 2 }),
    ]
    const { ready, blocked } = planReplay(q, {
        epoch: 3,
        resolveBaseKeyForList: (e) => (e.listId === 'holiday' ? 'ff00' : null),
        now: 10,
    })
    assert.deepEqual(ready.map((e) => e.id), ['stays'])
    assert.deepEqual(blocked.map((b) => b.reason), [BLOCKED_BASE_CHANGED])
})

test('attempts are recorded so a permanently failing entry is visible', () => {
    const once = noteAttempt(entry(), 500)
    assert.equal(once.attempts, 1)
    assert.equal(once.lastAttemptAt, 500)
    assert.equal(noteAttempt(once, 900).attempts, 2)
})

test('the queue round-trips through persistence', () => {
    const q = [entry({ id: 'a' }), entry({ id: 'b' })]
    assert.deepEqual(deserialize(serialize(q)).map((e) => e.id), ['a', 'b'])
})

test('a corrupt outbox yields an empty queue instead of throwing', () => {
    // A backend must still start. Dropping a malformed entry beats replaying an
    // unintelligible one.
    for (const raw of ['', 'not json', '{}', '[]', '{"version":99,"entries":[]}', null, undefined]) {
        assert.deepEqual(deserialize(raw), [], JSON.stringify(raw) ?? 'undefined')
    }
})

test('malformed entries inside a valid file are dropped, the rest survive', () => {
    const raw = JSON.stringify({
        version: 1,
        entries: [{ id: 'good', command: 3 }, { id: '' }, { command: 4 }, null, { id: 'ok', command: 5 }],
    })
    assert.deepEqual(deserialize(raw).map((e) => e.id), ['good', 'ok'])
})

test('a command may be a string tag or a number', () => {
    // The backend queues by operation type ('ADD'); an RPC command number is
    // equally valid. This module never interprets it — the replay driver does.
    assert.equal(createOutboxEntry({ id: 'a', command: 'ADD', now: 1 }).command, 'ADD')
    assert.equal(createOutboxEntry({ id: 'b', command: 12, now: 1 }).command, 12)
    assert.throws(() => createOutboxEntry({ id: 'c', command: '' }), /command/)

    const raw = JSON.stringify({ version: 1, entries: [{ id: 'ok', command: 'UPDATE' }, { id: 'bad', command: '' }] })
    assert.deepEqual(deserialize(raw).map((e) => e.id), ['ok'])
})
