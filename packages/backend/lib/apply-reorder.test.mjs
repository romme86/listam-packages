// Release 1a.7: the harness Release 2.1 needs before `apply` can be made
// deterministic.
//
// Autobase's own documentation is explicit: "while updating the view in the
// `apply` function, the `view` argument is the only data structure being
// updated and [it must be] fully deterministic. If any external data structures
// are used, these updates will not be correctly undone." Messages get reordered
// as new data arrives, and updates are undone and reapplied internally.
//
// Listam's apply does mutate external state — ctx.currentList via setCurrentList,
// membership and board-config projections, the shared-base routing index — and
// it emits RPC frames to the frontend. None of that participates in Autobase's
// undo.
//
// The invariant that catches it needs no exotic API: after any amount of
// reordering, the state apply ACCUMULATED must equal a from-scratch rebuild of
// the COMMITTED view. If they differ, apply left something behind that a rollback
// did not remove.
//
// These tests are expected to be RED until 2.1 lands. That is the point: they
// are the executable definition of "done" for it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setBackendFs } from './platform-fs.mjs'
import { createBaseContext } from './base-context.mjs'
import createTestnet from 'hyperdht/testnet.js'
import {
    openSharedBase,
    closeSharedBase,
    bootstrapSharedOwner,
    setupSharedPairing,
    createSharedInvite,
    joinSharedBaseViaInvite,
} from './shared-base.mjs'
import { addItem, updateItem, deleteItem, clearWriteChain } from './item.mjs'
import { createViewCheckpoint } from './view-checkpoint.mjs'
import { setRpc } from './state.mjs'

setBackendFs(fs)

function mkdir () {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'listam-reorder-'))
}

// A from-scratch reduction of the COMMITTED view: a brand-new checkpoint, so it
// shares no state with the one apply has been mutating. This is ground truth.
async function rebuildFromView (ctx) {
    const checkpoint = createViewCheckpoint()
    const { items } = await checkpoint.update(ctx.autobase.view, { onError: () => {} })
    return items
}

const norm = (items) => [...items]
    .map((i) => ({ id: i.id, text: i.text, isDone: !!i.isDone, listId: i.listId, listType: i.listType }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))

// Replicate two corestores over an in-memory pair, so a test controls exactly
// when data crosses — which is what makes a reorder reproducible instead of a
// race. Returns a teardown that ends both sides.
function connect (storeA, storeB) {
    const a = storeA.replicate(true)
    const b = storeB.replicate(false)
    a.pipe(b).pipe(a)
    return async () => {
        try { a.destroy() } catch {}
        try { b.destroy() } catch {}
    }
}

async function settle (ctx, rounds = 6) {
    for (let i = 0; i < rounds; i++) {
        await ctx.autobase.update()
        await new Promise((r) => setTimeout(r, 60))
    }
}

test('apply leaves no state a rollback did not remove (single writer)', async (t) => {
    // Baseline. With one writer nothing reorders, so accumulated and rebuilt
    // state must agree — if this fails, the invariant itself is wrong and the
    // concurrent cases below would be meaningless.
    const ctx = createBaseContext({ role: 'shared' })
    const dir = mkdir()
    await openSharedBase(ctx, { storageDir: dir, joinSwarm: false })
    t.after(async () => {
        clearWriteChain(ctx)
        await closeSharedBase(ctx)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    await addItem('Milk', 'default', 'shopping', null, ctx)
    await addItem('Bread', 'default', 'shopping', null, ctx)
    const target = ctx.currentList.find((i) => i.text === 'Milk')
    await updateItem({ ...target, text: 'Oat milk' }, ctx)
    await ctx.autobase.update()

    assert.deepEqual(
        norm(ctx.currentList),
        norm(await rebuildFromView(ctx)),
        'accumulated state must equal a from-scratch rebuild of the committed view',
    )
})

test('apply survives a delete reducing over an accumulated projection', async (t) => {
    const ctx = createBaseContext({ role: 'shared' })
    const dir = mkdir()
    await openSharedBase(ctx, { storageDir: dir, joinSwarm: false })
    t.after(async () => {
        clearWriteChain(ctx)
        await closeSharedBase(ctx)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    await addItem('Milk', 'default', 'shopping', null, ctx)
    await addItem('Bread', 'default', 'shopping', null, ctx)
    await addItem('Eggs', 'default', 'shopping', null, ctx)
    await ctx.autobase.update()
    const doomed = ctx.currentList.find((i) => i.text === 'Bread')
    await deleteItem(doomed, ctx)
    await ctx.autobase.update()

    const rebuilt = await rebuildFromView(ctx)
    assert.deepEqual(norm(ctx.currentList), norm(rebuilt))
    assert.equal(rebuilt.some((i) => i.text === 'Bread'), false, 'the delete must be in the committed view')
})

// Two AUTHORIZED writers on one base, then a deliberate partition.
//
// A peer that merely opens the same base key is not a writer — Autobase refuses
// its appends, so there is no second branch and nothing to reorder. (An earlier
// draft of this file made exactly that mistake and passed vacuously.) B must
// join through a real invite, which needs a DHT; once both are writable the
// swarms are torn down so the partition is deterministic, and the two stores are
// reconnected directly.
async function twoWriters (t) {
    const testnet = await createTestnet(3)
    const bootstrap = testnet.bootstrap
    const dirA = mkdir()
    const dirB = mkdir()
    const ctxA = createBaseContext({ role: 'shared' })

    await openSharedBase(ctxA, { storageDir: dirA, bootstrap })
    await bootstrapSharedOwner(ctxA)
    setupSharedPairing(ctxA)
    const invite = createSharedInvite(ctxA)
    assert.ok(invite, 'owner minted an invite')

    const joined = await joinSharedBaseViaInvite(createBaseContext, { invite, storageDir: dirB, bootstrap })
    const ctxB = joined.ctx
    assert.equal(joined.writable, true, 'B must be an authorized writer or there is no second branch')

    // Partition: drop both swarms so neither peer can see the other's appends.
    for (const ctx of [ctxA, ctxB]) {
        try { if (ctx.discovery) await ctx.discovery.destroy() } catch {}
        try { if (ctx.swarm) await ctx.swarm.destroy() } catch {}
        ctx.swarm = null
        ctx.discovery = null
    }

    let disconnect = null
    t.after(async () => {
        if (disconnect) await disconnect()
        clearWriteChain(ctxA)
        clearWriteChain(ctxB)
        await closeSharedBase(ctxA)
        await closeSharedBase(ctxB)
        await testnet.destroy()
        fs.rmSync(dirA, { recursive: true, force: true })
        fs.rmSync(dirB, { recursive: true, force: true })
    })

    return {
        ctxA,
        ctxB,
        heal: async () => {
            disconnect = connect(ctxA.store, ctxB.store)
            await settle(ctxA, 10)
            await settle(ctxB, 10)
        },
    }
}

test('CONCURRENT writers: accumulated state equals a rebuild after linearization', { timeout: 300_000 }, async (t) => {
    const { ctxA, ctxB, heal } = await twoWriters(t)

    // Partitioned: each peer appends a branch the other has not seen.
    assert.equal(await addItem('From A', 'default', 'shopping', null, ctxA), true)
    assert.equal(await addItem('From B', 'default', 'shopping', null, ctxB), true)

    await heal()

    // Non-vacuity: unless BOTH branches landed, nothing was ever reordered and
    // the invariant below would hold trivially.
    for (const [name, ctx] of [['A', ctxA], ['B', ctxB]]) {
        const texts = ctx.currentList.map((i) => i.text).sort()
        assert.deepEqual(texts, ['From A', 'From B'], `peer ${name} must see both branches (got ${texts})`)
    }

    for (const [name, ctx] of [['A', ctxA], ['B', ctxB]]) {
        assert.deepEqual(
            norm(ctx.currentList),
            norm(await rebuildFromView(ctx)),
            `peer ${name}: apply's accumulated list diverged from the committed view after linearization`,
        )
    }
})

test('CONCURRENT edits to the SAME item converge identically on both peers', { timeout: 300_000 }, async (t) => {
    const { ctxA, ctxB, heal } = await twoWriters(t)

    // Seed one item and let both peers agree on its id before the concurrent edit.
    assert.equal(await addItem('Milk', 'default', 'shopping', null, ctxA), true)
    await heal()
    const seeded = ctxB.currentList.find((i) => i.text === 'Milk')
    assert.ok(seeded, 'B must replicate the seeded item before the concurrent edit')

    // Same id, two writers, LWW by updatedAt — the later stamp must win on both.
    // Stamps are derived from the seeded item's own updatedAt (a real Date.now()
    // from the add), because an absolute literal would be OLDER than the add and
    // LWW would correctly discard both edits.
    const base = Number(seeded.updatedAt) || Date.now()
    assert.equal(await updateItem({ ...seeded, text: 'Oat milk', updatedAt: base + 1000 }, ctxA), true)
    assert.equal(await updateItem({ ...seeded, text: 'Soy milk', updatedAt: base + 2000 }, ctxB), true)
    await settle(ctxA, 10)
    await settle(ctxB, 10)

    for (const [name, ctx] of [['A', ctxA], ['B', ctxB]]) {
        assert.deepEqual(
            norm(ctx.currentList),
            norm(await rebuildFromView(ctx)),
            `peer ${name}: accumulated list diverged from the committed view`,
        )
    }
    assert.deepEqual(norm(ctxA.currentList), norm(ctxB.currentList), 'both peers must converge on the same winner')
    assert.equal(ctxA.currentList.find((i) => i.id === seeded.id)?.text, 'Soy milk', 'the later updatedAt must win')
})

// The list projection above survives reordering because applyOperationToList is
// an id-keyed LWW reduction: reapplying the same operations in a different order
// converges. That is a real mitigation, and it is why the tests above are green.
//
// The side effects apply performs are a different matter. pushFromBackend emits
// an RPC frame to the frontend the moment an operation is applied — including
// during a pass Autobase later UNDOES. Nothing un-emits a frame. This is the
// part of finding 2.1 the projection invariant cannot see, so it gets its own
// assertion: every operation the UI was told about must exist in the final
// committed view.
test('EMITTED EFFECTS: the frontend is never told about an operation the view discards', { timeout: 300_000 }, async (t) => {
    const frames = []
    setRpc({
        request: (command) => ({
            command,
            send: (data) => {
                try { frames.push({ command, item: JSON.parse(data) }) } catch { /* non-item frame */ }
            },
        }),
    })
    t.after(() => setRpc(null))

    const { ctxA, ctxB, heal } = await twoWriters(t)

    assert.equal(await addItem('From A', 'default', 'shopping', null, ctxA), true)
    assert.equal(await addItem('From B', 'default', 'shopping', null, ctxB), true)
    await heal()

    const committed = new Set((await rebuildFromView(ctxA)).map((i) => i.id))
    // Frames for reserved buckets and non-item payloads are not list rows.
    const announced = frames
        .map((f) => f.item)
        .filter((i) => i && typeof i === 'object' && typeof i.id === 'string' && typeof i.text === 'string')

    const phantom = announced.filter((i) => !committed.has(i.id))
    assert.deepEqual(
        phantom.map((i) => ({ id: i.id, text: i.text })),
        [],
        'the UI was told about operations that are not in the committed view — apply emitted during a pass that was later undone',
    )
})
