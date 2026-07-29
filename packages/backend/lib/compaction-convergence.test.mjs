// The fork-safety proof for history compaction.
//
// Compaction is a change to what apply() ADMITS, which is normally the exact
// hazard the rollout flags exist for: a peer that keeps an operation an older
// peer drops forks the mesh permanently. Compaction is exempt for one specific
// reason — normalizeListOperation() returns null for any type outside
// LIST_OPERATION_TYPES, so a peer on an older build DROPS the barrier record and
// simply reduces the whole history, arriving at the same state by doing more
// work.
//
// That exemption holds on one condition, and this file is its executable
// statement:
//
//     the snapshot must be exactly the reduction of what the barrier supersedes.
//
// If that is ever false, a compacting peer and an older peer converge on
// different states and never reconcile. So the assertion below is not "the
// feature works" — it is "the feature cannot fork the mesh".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setBackendFs } from './platform-fs.mjs'
import { createBaseContext } from './base-context.mjs'
import { openSharedBase, closeSharedBase, bootstrapSharedOwner } from './shared-base.mjs'
import { setRpc } from './state.mjs'
import { apply } from '../backend.mjs'
import { createListOperation } from './list-reducer.mjs'
import { createViewCheckpoint } from './view-checkpoint.mjs'
import {
    buildCompactionSnapshot,
    clockFromHeads,
    createCompactionRecord,
    seedCompactionBarrier,
    snapshotDigestHex,
} from './compaction.mjs'

setBackendFs(fs)

function mkdir () {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'listam-compaction-'))
}

function item (fields) {
    return { isDone: false, timeOfCompletion: 0, updatedAt: 1000, ...fields }
}

function makeView (seed = []) {
    const entries = [...seed]
    return {
        entries,
        get length () { return entries.length },
        async get (i) { return entries[i] },
        async append (entry) { entries.push(entry) },
    }
}

const noopHost = {
    addWriter: async () => {},
    removeWriter: async () => {},
    removeable: () => true,
}

// Returns the ctx plus the committed prefix every pass must fork from: whatever
// real apply already wrote for the owner bootstrap. Without it the test views
// start empty, membershipState rebuilds with NO owner, and every barrier is
// refused as 'missing-owner' — which makes the snapshot-gate test pass for
// entirely the wrong reason. (It did, in the first draft.)
async function ownedBase (t) {
    const ctx = createBaseContext({ role: 'shared' })
    const dir = mkdir()
    await openSharedBase(ctx, { storageDir: dir, joinSwarm: false })
    await bootstrapSharedOwner(ctx)
    await ctx.autobase.update()
    t.after(async () => {
        setRpc(null)
        await closeSharedBase(ctx)
        fs.rmSync(dir, { recursive: true, force: true })
    })
    const forkPoint = []
    for (let i = 0; i < ctx.autobase.view.length; i++) forkPoint.push(await ctx.autobase.view.get(i))
    assert.ok(
        forkPoint.some((e) => e?.op === 'membership'),
        'precondition: the fork point carries the owner bootstrap record',
    )
    return { ctx, forkPoint }
}

// Reduce a view the way every consumer does, so the comparison is over real
// projected state rather than raw entries.
async function reduceView (view) {
    const checkpoint = createViewCheckpoint()
    const { allItems } = await checkpoint.update(view, { onError: () => {} })
    return [...allItems].sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

async function runApply (ctx, nodes, view) {
    setRpc(null)
    await apply(ctx, nodes, view, noopHost)
}

// A history of ordinary edits ACROSS SEVERAL LIST BUCKETS.
//
// The bucket spread is the whole point. The reducer keys buckets by listId, so a
// `list` operation replaces one bucket — and a single-bucket fixture cannot
// distinguish "compaction preserved the state" from "the snapshot happened to
// overwrite the one bucket under test on both peers". The first draft of this
// file was single-bucket and stayed green when the snapshot was mutated to drop
// an item, because the snapshot dominated on BOTH sides.
function buildHistory (writerKey) {
    const from = { key: writerKey }
    const ops = [
        createListOperation('add', item({ id: 'a', text: 'alpha', listId: 'work', listType: 'todo' })),
        createListOperation('add', item({ id: 'b', text: 'beta', listId: 'work', listType: 'todo' })),
        createListOperation('update', item({ id: 'a', text: 'alpha edited', listId: 'work', listType: 'todo', updatedAt: 2000 })),
        createListOperation('add', item({ id: 'c', text: 'gamma', listId: 'home', listType: 'grocery' })),
        createListOperation('add', item({ id: 'd', text: 'shopping', listId: 'errands', listType: 'todo' })),
    ]
    // What those edits reduce to — and therefore exactly what the snapshot must
    // contain, in every bucket, for the convergence property to hold.
    const settled = [
        item({ id: 'a', text: 'alpha edited', listId: 'work', listType: 'todo', updatedAt: 2000 }),
        item({ id: 'b', text: 'beta', listId: 'work', listType: 'todo' }),
        item({ id: 'c', text: 'gamma', listId: 'home', listType: 'grocery' }),
        item({ id: 'd', text: 'shopping', listId: 'errands', listType: 'todo' }),
    ]
    return {
        nodes: ops.map((value, i) => ({ value, from, length: i + 1 })),
        settled,
        supersededThrough: ops.length,
    }
}

// The owner's snapshot: one list op per bucket, covering the whole reduction.
function snapshotNodes (settled, writerKey, startLength) {
    return buildCompactionSnapshot(settled).map((group, i) => ({
        value: createListOperation('list', group.items, { listId: group.listId, listType: group.listType }),
        from: { key: writerKey },
        length: startLength + i,
    }))
}

test('a compacting peer and a peer that ignores the barrier reduce to the same state', async (t) => {
    const { ctx, forkPoint } = await ownedBase(t)
    const writerKey = ctx.autobase.local.key
    const { nodes, settled, supersededThrough } = buildHistory(writerKey)

    const barrier = createCompactionRecord({
        ownerAuthorityKeyPair: ctx.ownerAuthorityKeyPair,
        baseKey: ctx.autobase.key,
        sequence: 1,
        epoch: 7,
        snapshotDigest: snapshotDigestHex(settled),
        clock: clockFromHeads([{ key: writerKey, length: supersededThrough }]),
        createdAt: 3000,
    })
    const snapshot = snapshotNodes(settled, writerKey, supersededThrough + 1)

    // OLD PEER: does not understand the barrier, so it replays everything.
    // Simulated the way reality produces it — the record simply never reduces.
    const oldView = makeView(forkPoint)
    await runApply(ctx, [...nodes, ...snapshot], oldView)
    const oldState = await reduceView(oldView)

    // NEW PEER, joining: seeded with the barrier from its invite BEFORE the base
    // opens, so it skips the superseded history from the very first batch. This
    // is the case the whole feature exists for.
    const joiner = (await ownedBase(t)).ctx
    joiner.setCompactionState(seedCompactionBarrier(barrier))
    const newView = makeView(forkPoint)
    await runApply(joiner, [...nodes, ...snapshot], newView)
    const newState = await reduceView(newView)

    assert.deepEqual(newState, oldState, 'compaction changed the reduced state — this forks the mesh')
    assert.ok(newState.length > 0, 'precondition: the comparison is not over two empty states')
})

test('the compacting peer actually skipped the history rather than replaying it', async (t) => {
    // Guards against the assertion above passing for the wrong reason: identical
    // states are also what you get if the barrier is silently inert.
    const { ctx, forkPoint } = await ownedBase(t)
    const writerKey = ctx.autobase.local.key
    const { nodes, settled, supersededThrough } = buildHistory(writerKey)

    const barrier = createCompactionRecord({
        ownerAuthorityKeyPair: ctx.ownerAuthorityKeyPair,
        baseKey: ctx.autobase.key,
        sequence: 1,
        epoch: 7,
        snapshotDigest: snapshotDigestHex(settled),
        clock: clockFromHeads([{ key: writerKey, length: supersededThrough }]),
        createdAt: 3000,
    })

    const replayView = makeView(forkPoint)
    await runApply(ctx, [...nodes], replayView)
    const replayedEntries = replayView.entries.length - forkPoint.length

    const joiner = (await ownedBase(t)).ctx
    joiner.setCompactionState(seedCompactionBarrier(barrier))
    const skipView = makeView(forkPoint)
    await runApply(joiner, [...nodes], skipView)

    assert.equal(skipView.entries.length - forkPoint.length, 0, 'superseded ops still produced view entries')
    assert.ok(replayedEntries > 0, 'precondition: an uncompacted peer does write those entries')
})

test('a write made concurrently with the barrier survives compaction', async (t) => {
    // The acceptHeldEpochOps guarantee (2026-07-28): an innocent member writing
    // without having seen the barrier must not lose the write. Its node sits
    // ABOVE the barrier's clock, so coverage-by-clock admits it.
    const { ctx, forkPoint } = await ownedBase(t)
    const writerKey = ctx.autobase.local.key
    const { nodes, settled, supersededThrough } = buildHistory(writerKey)

    const barrier = createCompactionRecord({
        ownerAuthorityKeyPair: ctx.ownerAuthorityKeyPair,
        baseKey: ctx.autobase.key,
        sequence: 1,
        epoch: 7,
        snapshotDigest: snapshotDigestHex(settled),
        clock: clockFromHeads([{ key: writerKey, length: supersededThrough }]),
        createdAt: 3000,
    })

    const concurrent = {
        value: createListOperation('add', item({ id: 'late', text: 'written mid-compaction', listId: 'work', listType: 'todo' })),
        from: { key: writerKey },
        length: supersededThrough + 5,
    }
    const snapshot = snapshotNodes(settled, writerKey, supersededThrough + 1)

    const joiner = (await ownedBase(t)).ctx
    joiner.setCompactionState(seedCompactionBarrier(barrier))
    const view = makeView(forkPoint)
    await runApply(joiner, [...nodes, ...snapshot, concurrent], view)

    const state = await reduceView(view)
    assert.ok(state.some((i) => i.id === 'late'), 'a concurrent write was swallowed by compaction')
})

test('a barrier whose snapshot never landed suppresses nothing', async (t) => {
    // rekey.mjs can commit a removal and still fail to write its re-encrypted
    // snapshot. Honouring such a barrier would be data loss, not compaction —
    // so a barrier discovered in the LOG stays inert until the reduction it
    // holds matches the digest the owner signed.
    const { ctx, forkPoint } = await ownedBase(t)
    const writerKey = ctx.autobase.local.key
    const { nodes, settled, supersededThrough } = buildHistory(writerKey)

    const barrier = createCompactionRecord({
        ownerAuthorityKeyPair: ctx.ownerAuthorityKeyPair,
        baseKey: ctx.autobase.key,
        sequence: 1,
        epoch: 7,
        snapshotDigest: snapshotDigestHex(settled),
        clock: clockFromHeads([{ key: writerKey, length: supersededThrough }]),
        createdAt: 3000,
    })
    const barrierNode = { value: barrier, from: { key: writerKey }, length: supersededThrough + 1 }

    // The barrier arrives with NO snapshot behind it, then more history follows.
    const view = makeView(forkPoint)
    await runApply(ctx, [barrierNode, ...nodes], view)

    const state = await reduceView(view)
    assert.equal(state.length, 4, 'history was suppressed by a barrier with no snapshot')
})
