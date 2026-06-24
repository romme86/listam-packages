import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setBackendFs } from './platform-fs.mjs'
import { createBaseContext } from './base-context.mjs'
import { openSharedBase, closeSharedBase } from './shared-base.mjs'
import { addItem, updateItem, deleteItem, clearWriteChain } from './item.mjs'
import { currentList as personalCurrentList } from './state.mjs'

setBackendFs(fs) // openSharedBase persists the base encryption key via the fs adapter

function mkdir () {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'listam-mbw-'))
}

// The RPC write path (addItem/updateItem/deleteItem) routes to a SHARED base
// when given its ctx — appending to THAT base's autobase and reducing into its
// own ctx.currentList — without ever touching the personal globals. This is the
// engine seam single-list sharing routes a shared list's mutations through.
test('ctx-routed writes land in the shared base, isolated from the personal globals', async () => {
    const ctxA = createBaseContext({ role: 'shared' })
    const ctxB = createBaseContext({ role: 'shared' })
    const dirA = mkdir()
    const dirB = mkdir()
    await openSharedBase(ctxA, { storageDir: dirA, joinSwarm: false })
    await openSharedBase(ctxB, { storageDir: dirB, joinSwarm: false })
    try {
        assert.equal(ctxA.autobase.writable, true)
        assert.equal(ctxB.autobase.writable, true)

        // Write to base A through the ctx-aware addItem.
        const okA = await addItem('Milk', 'default', 'shopping', null, ctxA)
        assert.equal(okA, true)
        await ctxA.autobase.update()
        assert.equal(ctxA.currentList.length, 1)
        assert.equal(ctxA.currentList[0].text, 'Milk')

        // Base B is untouched by A's write (isolation between shared bases).
        await ctxB.autobase.update()
        assert.equal(ctxB.currentList.length, 0)

        // A write to B stays in B; A keeps only its own item.
        const okB = await addItem('Eggs', 'default', 'shopping', null, ctxB)
        assert.equal(okB, true)
        await ctxB.autobase.update()
        await ctxA.autobase.update()
        assert.deepEqual(ctxB.currentList.map((i) => i.text), ['Eggs'])
        assert.deepEqual(ctxA.currentList.map((i) => i.text), ['Milk'])

        // update + delete also route to the right base.
        await updateItem({ ...ctxA.currentList[0], isDone: true, updatedAt: Date.now() + 1 }, ctxA)
        await ctxA.autobase.update()
        assert.equal(ctxA.currentList[0].isDone, true)

        await deleteItem(ctxB.currentList[0], ctxB)
        await ctxB.autobase.update()
        assert.equal(ctxB.currentList.length, 0)

        // The personal globals never saw any of these writes.
        assert.deepEqual(personalCurrentList, [])
    } finally {
        await closeSharedBase(ctxA)
        await closeSharedBase(ctxB)
    }
})

// Closing a shared base drops its per-base write chain (clearWriteChain), so a
// base reopened under the SAME id starts on a fresh chain and does not deadlock
// behind its predecessor's settled writes. Regression guard for the write-chain
// lifecycle (the chain must not be inherited across an open/close/open cycle).
test('a shared base reopened with the same id still accepts writes', async () => {
    const dir = mkdir()
    const ctx1 = createBaseContext({ role: 'shared' })
    await openSharedBase(ctx1, { storageDir: dir, joinSwarm: false })
    const baseId = ctx1.baseId
    await addItem('First', 'default', 'shopping', null, ctx1)
    await ctx1.autobase.update()
    assert.equal(ctx1.currentList.length, 1)
    clearWriteChain(ctx1)
    await closeSharedBase(ctx1)

    // Reopen the same on-disk base (same baseId) into a fresh context.
    const ctx2 = createBaseContext({ role: 'shared' })
    await openSharedBase(ctx2, { storageDir: dir, joinSwarm: false })
    try {
        assert.equal(ctx2.baseId, baseId, 'same base id on reopen')
        const ok = await addItem('Second', 'default', 'shopping', null, ctx2)
        assert.equal(ok, true)
        await ctx2.autobase.update()
        assert.ok(ctx2.currentList.some((i) => i.text === 'Second'), 'write after reopen lands')
    } finally {
        await closeSharedBase(ctx2)
    }
})

// A board ticket written to a shared base reads that base's boardConfigState
// (default rigor ON) and localWriter (not the personal globals) — the createdBy
// stamp comes from the shared base's own writer key, and the rigor gate applied
// is the shared base's own reduced config.
test('board ticket on a shared base is stamped with that base local writer', async () => {
    const ctx = createBaseContext({ role: 'shared' })
    const dir = mkdir()
    await openSharedBase(ctx, { storageDir: dir, joinSwarm: false })
    try {
        // Default board config is rigor ON, so the ticket must carry the
        // required fields or apply() silently drops it.
        const ok = await addItem('Ship it', 'default', 'kanban', {
            status: 'todo',
            description: 'Ship the release',
            checklist: [{ text: 'build' }],
            estimatedHours: 4,
            estimatedComplexity: 30,
        }, ctx)
        assert.equal(ok, true)
        await ctx.autobase.update()
        assert.equal(ctx.currentList.length, 1)
        const ticket = ctx.currentList[0]
        assert.equal(ticket.status, 'todo')
        assert.equal(ticket.createdBy, ctx.autobase.local.key.toString('hex'))
    } finally {
        await closeSharedBase(ctx)
    }
})
