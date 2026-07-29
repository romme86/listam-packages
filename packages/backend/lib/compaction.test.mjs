import test from 'node:test'
import assert from 'node:assert/strict'
import { keyPair } from 'hypercore-crypto'

import { createListReduction, createListOperation } from './list-reducer.mjs'
import {
    buildCompactionSnapshot,
    clockFromHeads,
    confirmSnapshot,
    createCompactionRecord,
    createCompactionState,
    isCompactionRecord,
    isNodeCovered,
    reduceCompactionOperation,
    snapshotDigestHex,
} from './compaction.mjs'

const BASE_KEY = 'ab'.repeat(32)
const WRITER_A = '11'.repeat(32)
const WRITER_B = '22'.repeat(32)

const ITEMS = [
    { id: 'i1', listId: 'l', listType: 'todo', text: 'one', isDone: false, updatedAt: 10 },
    { id: 'i2', listId: 'l', listType: 'todo', text: 'two', isDone: true, updatedAt: 20 },
]

function owner() {
    return keyPair()
}

function record(kp, overrides = {}) {
    return createCompactionRecord({
        ownerAuthorityKeyPair: kp,
        baseKey: BASE_KEY,
        sequence: 1,
        epoch: 7,
        snapshotDigest: snapshotDigestHex(ITEMS),
        clock: [{ writerKey: WRITER_A, length: 500 }, { writerKey: WRITER_B, length: 300 }],
        createdAt: 1000,
        ...overrides,
    })
}

function reduce(kp, rec, state = createCompactionState()) {
    return reduceCompactionOperation(rec, state, {
        baseKey: BASE_KEY,
        ownerAuthorityKey: Buffer.from(kp.publicKey).toString('hex'),
    })
}

test('an owner-signed barrier is accepted and carries its clock', () => {
    const kp = owner()
    const result = reduce(kp, record(kp))

    assert.equal(result.ok, true)
    assert.equal(result.state.sequence, 1)
    assert.equal(result.state.epoch, 7)
    assert.equal(result.state.clock.get(WRITER_A), 500)
    assert.equal(result.state.clock.get(WRITER_B), 300)
})

test('isCompactionRecord only matches the barrier type', () => {
    const kp = owner()
    assert.equal(isCompactionRecord(record(kp)), true)
    assert.equal(isCompactionRecord({ type: 'membership' }), false)
    assert.equal(isCompactionRecord(null), false)
})

test('a barrier signed by anyone but the committed owner is refused', () => {
    const kp = owner()
    const impostor = owner()
    const result = reduce(kp, record(impostor))
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'wrong-owner')
})

test('a tampered barrier fails signature verification', () => {
    const kp = owner()
    const forged = { ...record(kp), epoch: 99 }
    const result = reduce(kp, forged)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'bad-signature')
})

test('a barrier minted for another base is refused', () => {
    const kp = owner()
    const result = reduce(kp, record(kp, { baseKey: 'cd'.repeat(32) }))
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'wrong-base')
})

test('a replayed barrier cannot move the clock backwards', () => {
    const kp = owner()
    const first = reduce(kp, record(kp, { sequence: 2, clock: [{ writerKey: WRITER_A, length: 900 }] }))
    assert.equal(first.ok, true)

    const replay = reduce(kp, record(kp, { sequence: 2, clock: [{ writerKey: WRITER_A, length: 1 }] }), first.state)
    assert.equal(replay.ok, false)
    assert.equal(replay.reason, 'replay')
    assert.equal(replay.state.clock.get(WRITER_A), 900)
})

test('a barrier is inert until the snapshot it names is confirmed', () => {
    // The safety gate: rekey.mjs can commit a removal and still fail to write
    // its re-encrypted snapshot. A barrier whose snapshot never landed must
    // never suppress the history it claims to replace.
    const kp = owner()
    const { state } = reduce(kp, record(kp))
    assert.equal(state.honoured, false)

    const node = { length: 10 }
    assert.equal(isNodeCovered(node, state, WRITER_A), false, 'suppressed history without its snapshot')

    const confirmed = confirmSnapshot(state, ITEMS)
    assert.equal(confirmed.honoured, true)
    assert.equal(isNodeCovered(node, confirmed, WRITER_A), true)
})

test('a snapshot that does not match the signed digest never honours the barrier', () => {
    const kp = owner()
    const { state } = reduce(kp, record(kp))
    const wrong = confirmSnapshot(state, [{ id: 'other', listId: 'l', listType: 'todo', text: 'x', isDone: false, updatedAt: 1 }])
    assert.equal(wrong.honoured, false)
})

test('coverage is by clock, so a writer that had not seen the barrier is still admitted', () => {
    // This is what keeps the acceptHeldEpochOps fix (2026-07-28) intact: an
    // innocent member writing concurrently produces nodes ABOVE the clock, and
    // those must survive compaction.
    const kp = owner()
    const state = confirmSnapshot(reduce(kp, record(kp)).state, ITEMS)

    assert.equal(isNodeCovered({ length: 500 }, state, WRITER_A), true, 'at the clock is superseded')
    assert.equal(isNodeCovered({ length: 501 }, state, WRITER_A), false, 'a concurrent later write was dropped')
    assert.equal(isNodeCovered({ length: 9000 }, state, WRITER_A), false)
})

test('a writer absent from the clock is never covered', () => {
    // Heads are a frontier, so a dominated writer can be missing. Treating that
    // as "not covered" costs a little replay; the opposite would drop data.
    const kp = owner()
    const state = confirmSnapshot(reduce(kp, record(kp)).state, ITEMS)
    assert.equal(isNodeCovered({ length: 1 }, state, '33'.repeat(32)), false)
    assert.equal(isNodeCovered({ length: 1 }, state, null), false)
})

test('an uncompacted timeline covers nothing', () => {
    assert.equal(isNodeCovered({ length: 1 }, createCompactionState(), WRITER_A), false)
})

test('the snapshot digest is order-independent', () => {
    assert.equal(snapshotDigestHex(ITEMS), snapshotDigestHex([...ITEMS].reverse()))
    assert.notEqual(snapshotDigestHex(ITEMS), snapshotDigestHex(ITEMS.slice(0, 1)))
})

test('clockFromHeads converts autobase system heads and drops malformed entries', () => {
    const clock = clockFromHeads([
        { key: Buffer.from(WRITER_B, 'hex'), length: 12 },
        { key: Buffer.from(WRITER_A, 'hex'), length: 34 },
        { key: null, length: 5 },
        { key: Buffer.from(WRITER_A, 'hex'), length: -1 },
    ])
    assert.deepEqual(clock, [
        { writerKey: WRITER_A, length: 34 },
        { writerKey: WRITER_B, length: 12 },
    ])
})

test('a malformed clock makes the whole record invalid', () => {
    const kp = owner()
    const rec = record(kp)
    const duplicated = { ...rec, clock: [{ writerKey: WRITER_A, length: 1 }, { writerKey: WRITER_A, length: 2 }] }
    assert.equal(reduce(kp, duplicated).reason, 'malformed')
})

// ---------------------------------------------------------------------------
// The snapshot-equals-reduction invariant.
//
// compaction-convergence.test.mjs proves compaction cannot FORK the mesh, and it
// is deliberately blind to one thing: a snapshot that drops an item inside a
// bucket makes BOTH peers lose it (the list op replaces the bucket either way),
// so they agree — it is data loss, not divergence. Verified by mutation: that
// change leaves the convergence file green.
//
// What actually prevents it is that the owner never authors a snapshot by hand;
// buildCompactionSnapshot derives it from the reduction. So the invariant is a
// round trip, and this is where it is enforced.
// ---------------------------------------------------------------------------
test('a snapshot round-trips the reduction it was built from, in every bucket', () => {
    const allItems = [
        { id: 'a', listId: 'work', listType: 'todo', text: 'alpha', isDone: false, timeOfCompletion: 0, updatedAt: 1 },
        { id: 'b', listId: 'work', listType: 'todo', text: 'beta', isDone: true, timeOfCompletion: 5, updatedAt: 2 },
        { id: 'c', listId: 'home', listType: 'grocery', text: 'milk', isDone: false, timeOfCompletion: 0, updatedAt: 3 },
        { id: 'd', listId: null, listType: null, text: 'default bucket', isDone: false, timeOfCompletion: 0, updatedAt: 4 },
    ]

    // Both sides of the real comparison are REDUCED state: the owner snapshots
    // its own allItems(), and a peer confirms against its own. So the reference
    // has to be reduced too — comparing a digest of raw input against reduced
    // output only measures normalizeListItem's defaulting (listId: null becomes
    // the default bucket), not the round trip.
    const source = createListReduction()
    for (const item of allItems) source.applyOperation(createListOperation('add', item))
    const reference = source.allItems()

    const restored = createListReduction()
    for (const group of buildCompactionSnapshot(reference)) {
        restored.applyOperation(createListOperation('list', group.items, {
            listId: group.listId,
            listType: group.listType,
        }))
    }

    const byId = (list) => [...list].sort((l, r) => String(l.id).localeCompare(String(r.id))).map((i) => i.id)
    assert.deepEqual(byId(restored.allItems()), byId(reference))
    assert.equal(
        snapshotDigestHex(restored.allItems()),
        snapshotDigestHex(reference),
        'a peer would refuse this snapshot: its digest does not match the reduction it came from',
    )
})

test('every bucket gets its own snapshot group, so none is silently dropped', () => {
    // A single untargeted list op lands in the DEFAULT bucket only — which is
    // what rekey.mjs's epoch snapshot writes. Behind a barrier that would wipe
    // every named list on the peer that honoured it.
    const groups = buildCompactionSnapshot([
        { id: 'a', listId: 'work', listType: 'todo' },
        { id: 'b', listId: 'home', listType: 'grocery' },
        { id: 'c', listId: 'work', listType: 'todo' },
        { id: 'd', listId: null, listType: null },
    ])
    assert.equal(groups.length, 3)
    assert.deepEqual(groups.map((g) => g.items.length).sort(), [1, 1, 2])
})
