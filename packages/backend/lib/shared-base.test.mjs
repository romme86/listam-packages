import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setBackendFs } from './platform-fs.mjs'
import { createBaseContext } from './base-context.mjs'
import {
    openSharedBase,
    closeSharedBase,
    bootstrapSharedOwner,
    createSharedInvite,
    findSharedContextForInvite,
    rebuildSharedListFromView,
    sharedWriterMembershipRecordRequired,
} from './shared-base.mjs'
import { createListOperation, createListViewEntry } from './list-reducer.mjs'

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

test('a manual invite resolves to an already-open auto-joined context', async () => {
    const ctx = createBaseContext({ role: 'shared' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listam-sb-'))
    await openSharedBase(ctx, { storageDir: dir, joinSwarm: false })
    try {
        await bootstrapSharedOwner(ctx)
        const invite = createSharedInvite(ctx)
        assert.ok(invite, 'owner minted an invite')

        const decoy = {
            autobase: {
                writable: true,
                closing: false,
                discoveryKey: Buffer.alloc(32, 0x7f),
            },
        }
        assert.equal(findSharedContextForInvite([decoy, ctx], invite), ctx)

        const readOnlyMatch = {
            autobase: {
                writable: false,
                closing: false,
                discoveryKey: ctx.autobase.discoveryKey,
            },
        }
        assert.equal(findSharedContextForInvite([readOnlyMatch], invite), readOnlyMatch,
            'a pending auto-join must be reused instead of minting a second writer')
    } finally {
        await closeSharedBase(ctx)
    }
})

test('host pairing skips an already-active writer unless its epoch public key changed', () => {
    const writerKey = '11'.repeat(32)
    const epochPublicKey = '22'.repeat(32)
    const ctx = createBaseContext({ role: 'shared' })
    ctx.membershipState.writers.add(writerKey)
    ctx.membershipState.writerEpochPublicKeys.set(writerKey, epochPublicKey)

    assert.equal(sharedWriterMembershipRecordRequired(ctx, { writerKey, epochPublicKey }), false,
        'same active writer/key is already authorized')
    assert.equal(sharedWriterMembershipRecordRequired(ctx, { writerKey, epochPublicKey: null }), false,
        'legacy active writer without an epoch key does not need a duplicate record')
    assert.equal(sharedWriterMembershipRecordRequired(ctx, { writerKey, epochPublicKey: '33'.repeat(32) }), true,
        'a changed epoch key must still be owner-signed for future grants')
    assert.equal(sharedWriterMembershipRecordRequired(ctx, { writerKey: '44'.repeat(32), epochPublicKey }), true,
        'a genuinely new writer still needs an authorization record')
})

test('an incomplete shared-view rebuild retains the previous projection and retries', async () => {
    const ctx = createBaseContext({ role: 'shared' })
    const previous = {
        id: 'old', text: 'Keep visible', isDone: false, timeOfCompletion: 0,
        listId: 'spesa-2', listType: 'shopping', updatedAt: 1,
    }
    const milk = {
        id: 'milk', text: 'Milk', isDone: false, timeOfCompletion: 0,
        listId: 'spesa-2', listType: 'shopping', updatedAt: 2,
    }
    const bread = {
        id: 'bread', text: 'Bread', isDone: false, timeOfCompletion: 0,
        listId: 'spesa-2', listType: 'shopping', updatedAt: 3,
    }
    const entries = [
        createListViewEntry(createListOperation('add', milk, { listId: 'spesa-2', listType: 'shopping' })),
        new Error('block temporarily unavailable'),
    ]
    ctx.sharedListId = 'spesa-2'
    ctx.currentList = [previous]
    ctx.autobase = {
        key: Buffer.alloc(32, 1),
        view: {
            get length () { return entries.length },
            async get (index) {
                if (entries[index] instanceof Error) throw entries[index]
                return entries[index]
            },
        },
    }

    assert.equal(await rebuildSharedListFromView(ctx), false)
    assert.deepEqual(ctx.currentList, [previous], 'a partial scan cannot clear visible rows')

    entries[1] = createListViewEntry(createListOperation('add', bread, { listId: 'spesa-2', listType: 'shopping' }))
    assert.equal(await rebuildSharedListFromView(ctx), true)
    assert.deepEqual(ctx.currentList.map((item) => item.text).sort(), ['Bread', 'Milk'])
})
