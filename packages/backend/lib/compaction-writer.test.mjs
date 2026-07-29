import test from 'node:test'
import assert from 'node:assert/strict'
import { keyPair } from 'hypercore-crypto'

import { performCompaction } from './compaction-writer.mjs'
import { createCompactionState, isCompactionRecord, reduceCompactionOperation } from './compaction.mjs'

const BASE_KEY = Buffer.from('ab'.repeat(32), 'hex')
const WRITER_A = Buffer.from('11'.repeat(32), 'hex')

const READY = { ready: true, total: 2, readyCount: 2, blockers: [] }

const ITEMS = [
    { id: 'a', listId: 'work', listType: 'todo', text: 'alpha', isDone: false, updatedAt: 1 },
    { id: 'b', listId: 'home', listType: 'grocery', text: 'milk', isDone: false, updatedAt: 2 },
]

function harness(overrides = {}) {
    const owner = keyPair()
    const appended = []
    const autobase = {
        writable: true,
        key: BASE_KEY,
        system: { heads: [{ key: WRITER_A, length: 42 }] },
        append: async (value) => { appended.push(value) },
        update: async () => {},
        ...overrides.autobase,
    }
    return {
        owner,
        appended,
        autobase,
        args: {
            autobase,
            ownerAuthorityKeyPair: owner,
            membershipState: {
                ownerAuthorityKey: Buffer.from(owner.publicKey).toString('hex'),
                ownerWriterKey: WRITER_A.toString('hex'),
                currentEpoch: 7,
                highestSequence: 3,
                writers: new Set([WRITER_A.toString('hex')]),
            },
            compactionState: createCompactionState(),
            getAllItems: async () => ITEMS,
            prepareListAppendOperation: (op) => op,
            readiness: READY,
            now: () => 5000,
            ...overrides.args,
        },
    }
}

test('compaction writes one snapshot group per bucket, then the barrier', () => {
    return (async () => {
        const { args, appended } = harness()
        const result = await performCompaction(args)

        assert.equal(result.ok, true)
        assert.equal(result.buckets, 2)
        assert.equal(appended.length, 3, 'expected 2 snapshot groups + 1 barrier')
        assert.equal(appended.filter((v) => v.type === 'list').length, 2)
        assert.equal(isCompactionRecord(appended[2]), true, 'the barrier must come LAST')
    })()
})

test('the barrier clock is the frontier from BEFORE the snapshot was written', async () => {
    // If the clock were read after, the barrier would cover its own snapshot and
    // suppress the very data meant to replace the history it suppresses.
    const { args, appended } = harness()
    await performCompaction(args)

    const barrier = appended[2]
    assert.deepEqual(barrier.clock, [{ writerKey: WRITER_A.toString('hex'), length: 42 }])
})

test('a barrier is never written when the snapshot append fails', async () => {
    const appended = []
    const { args } = harness({
        autobase: {
            append: async (value) => {
                if (value?.type === 'list') throw new Error('disk full')
                appended.push(value)
            },
        },
    })
    const result = await performCompaction(args)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'snapshot-failed')
    assert.equal(appended.filter(isCompactionRecord).length, 0, 'wrote a barrier with no snapshot behind it')
})

test('compaction is refused until every device reports support', async () => {
    const { args, appended } = harness({
        args: { readiness: { ready: false, total: 3, readyCount: 2, blockers: [{ writerKey: 'zz', reason: 'outdated' }] } },
    })
    const result = await performCompaction(args)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'mesh-not-ready')
    assert.equal(appended.length, 0)
})

test('only the owner device can compact', async () => {
    const { args, appended } = harness({ args: { ownerAuthorityKeyPair: keyPair() } })
    const result = await performCompaction(args)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-owner')
    assert.equal(appended.length, 0)
})

test('a read-only base cannot compact', async () => {
    const { args } = harness({ autobase: { writable: false } })
    assert.equal((await performCompaction(args)).reason, 'not-writable')
})

test('compaction with nothing to snapshot is refused rather than writing an empty barrier', async () => {
    const { args, appended } = harness({ args: { getAllItems: async () => [] } })
    const result = await performCompaction(args)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'nothing-to-compact')
    assert.equal(appended.length, 0)
})

test('a second compaction supersedes the first rather than replaying its sequence', async () => {
    const first = harness()
    const firstResult = await performCompaction(first.args)

    const committed = reduceCompactionOperation(first.appended[2], createCompactionState(), {
        baseKey: BASE_KEY,
        ownerAuthorityKey: Buffer.from(first.owner.publicKey).toString('hex'),
    })
    assert.equal(committed.ok, true)

    const second = harness({ args: { compactionState: committed.state } })
    // Same owner keypair is required for the record to verify against the state.
    second.args.ownerAuthorityKeyPair = first.owner
    second.args.membershipState.ownerAuthorityKey = Buffer.from(first.owner.publicKey).toString('hex')
    const secondResult = await performCompaction(second.args)

    assert.ok(secondResult.sequence > firstResult.sequence)
    const applied = reduceCompactionOperation(second.appended[2], committed.state, {
        baseKey: BASE_KEY,
        ownerAuthorityKey: Buffer.from(first.owner.publicKey).toString('hex'),
    })
    assert.equal(applied.ok, true, 'the second barrier was refused as a replay')
})
