import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setBackendFs } from './platform-fs.mjs'
import { createBaseContext } from './base-context.mjs'
import { openSharedBase, closeSharedBase } from './shared-base.mjs'
import { createListOperation } from './list-reducer.mjs'

setBackendFs(fs) // openSharedBase persists the base encryption key via the fs adapter

// Verifies the shared-base open path + the ctx-bound apply end to end, in-process
// (no swarm): a write to the base flows through apply() — which is bound to THIS
// ctx — and lands in ctx.currentList, independent of the personal globals.
// (Cross-peer replication of a shared base reuses the same swarm pattern the
// desktop 2-peer sync test already exercises for the personal base.)
test('openSharedBase: a write flows through ctx-bound apply into ctx.currentList', async () => {
    const ctx = createBaseContext({ role: 'shared' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listam-sb-'))
    await openSharedBase(ctx, { storageDir: dir, joinSwarm: false })
    try {
        assert.equal(ctx.autobase.writable, true) // fresh base → this device bootstraps as the first writer
        assert.ok(ctx.baseKey, 'baseKey is set from the autobase key')
        assert.equal(ctx.role, 'shared')
        assert.deepEqual(ctx.currentList, [])

        const item = { id: 'i1', text: 'Milk', isDone: false, timeOfCompletion: 0, listId: 'default', listType: 'shopping', updatedAt: 1 }
        await ctx.autobase.append(createListOperation('add', item, { listId: 'default', listType: 'shopping' }))
        await ctx.autobase.update()

        assert.equal(ctx.currentList.length, 1)
        assert.equal(ctx.currentList[0].text, 'Milk')

        // A second op converges too (update on the same item).
        await ctx.autobase.append(createListOperation('update', { ...item, isDone: true, updatedAt: 2 }, { listId: 'default', listType: 'shopping' }))
        await ctx.autobase.update()
        assert.equal(ctx.currentList.length, 1)
        assert.equal(ctx.currentList[0].isDone, true)
    } finally {
        await closeSharedBase(ctx)
    }
})

test('openSharedBase persists the auto-generated encryption key for reuse on reopen', async () => {
    const ctx = createBaseContext({ role: 'shared' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listam-sb-'))
    await openSharedBase(ctx, { storageDir: dir, joinSwarm: false })
    try {
        const keyFile = path.join(dir, 'encryption.key')
        assert.ok(fs.existsSync(keyFile), 'encryption key file is written')
        assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), Buffer.from(ctx.encryptionKey).toString('hex'))
    } finally {
        await closeSharedBase(ctx)
    }
})
