// End-to-end: a list whose registry entry points at an unreachable shared base,
// with its items tombstoned in the personal log, is self-healed on boot — the
// list is re-pointed at the personal base and its items resurrected. Runs a real
// backend on a private DHT (single node = owner = flushable), so this exercises
// the full apply/reduce/write path the migration relies on.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { RPC_ADD } from '@listam/protocol'
import { startBackend, healOrphanedSharedLists } from './backend.mjs'
import { createNodePlatform, createNodeRpc } from './platform/node.mjs'
import { updateItem, deleteItem, rebuildAllItems } from './lib/item.mjs'
import { autobase } from './lib/state.mjs'
import { buildListMetaItem, reduceRegistry } from './lib/list-registry.mjs'

function mkdir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'listam-heal-')) }

test('boot self-heals a list orphaned by an unreachable shared base', async (t) => {
    const testnet = await createTestnet(3)
    const baseDir = mkdir()
    const platform = createNodePlatform({
        argv: [baseDir, '', '', ''], // no secrets → fresh base, this node is owner
        storageNamespace: 'healtest',
        bootstrap: testnet.bootstrap,
        leaseTtlMs: 60000,
        reply: () => JSON.stringify({ stored: true }),
    })

    let handle = null
    try {
        handle = await startBackend(platform)
        assert.equal(autobase.writable, true, 'owner node is writable')

        // Seed three items on the multiplexed 'default' surface — one of each
        // built-in type (shopping/kanban/todo), covering the board case. Seed via
        // updateItem (upsert) so we control ids and bypass the add-time board
        // rigor gate; the heal resurrects through the same update path.
        const seed = [
            { id: 's1', text: 'Pollo', listId: 'default', listType: 'shopping', isDone: false, timeOfCompletion: 0 },
            { id: 'k1', text: 'Job', listId: 'default', listType: 'kanban', status: 'todo', isDone: false, timeOfCompletion: 0 },
            { id: 't1', text: 'Pay rent', listId: 'default', listType: 'todo', isDone: false, timeOfCompletion: 0 },
        ]
        let stamp = Date.now()
        for (const it of seed) assert.equal(await updateItem({ ...it, updatedAt: ++stamp }), true)
        await autobase.update()
        let all = await rebuildAllItems()
        const ids = all.filter((i) => i.listId === 'default')
        assert.equal(ids.length, 3, 'three default items exist')

        // Point 'default' at a shared base this node can never open (fake key, no
        // local dir, no creds) — the orphaned-share state.
        const ORPHAN = 'a'.repeat(64)
        assert.equal(await updateItem(buildListMetaItem({
            id: 'default', name: 'Spesa', type: 'shopping', groupId: 'general', order: 0,
            baseKey: ORPHAN, updatedAt: Date.now(),
        })), true)

        // Tombstone the personal copies (what shareList does on a share).
        for (const it of ids) assert.equal(await deleteItem(it), true)
        await autobase.update()
        all = await rebuildAllItems()
        assert.equal(all.filter((i) => i.listId === 'default').length, 0, 'all default items tombstoned')
        assert.equal(reduceRegistry(all).lists.find((l) => l.id === 'default').baseKey, ORPHAN, 'default points at the orphan base')

        // Run the self-heal (idempotent; also runs automatically on boot).
        await healOrphanedSharedLists()
        await autobase.update()

        all = await rebuildAllItems()
        const healed = all.filter((i) => i.listId === 'default')
        assert.equal(healed.length, 3, 'all three items resurrected')
        assert.deepEqual(healed.map((i) => i.text).sort(), ['Job', 'Pay rent', 'Pollo'])
        // Original ids preserved (so day-plan pointers still resolve).
        assert.deepEqual(healed.map((i) => i.id).sort(), ids.map((i) => i.id).sort())
        assert.equal(reduceRegistry(all).lists.find((l) => l.id === 'default').baseKey, null, 'default un-shared')

        // Idempotent: a second pass (marker recorded) changes nothing.
        await healOrphanedSharedLists()
        await autobase.update()
        assert.equal((await rebuildAllItems()).filter((i) => i.listId === 'default').length, 3, 'no duplicate resurrection')
    } finally {
        if (handle?.shutdown) { try { await handle.shutdown() } catch (_) {} }
        try { await testnet.destroy() } catch (_) {}
    }
})

// Security: a poisoned/legacy regBaseKey pointing the built-in 'default' surface
// at a foreign base must NOT route (or refuse) built-in writes — 'default' is
// always personal-base. Reaches resolveWriteContext via the real RPC handler.
test('writes to the built-in default surface ignore any regBaseKey routing', async (t) => {
    const testnet = await createTestnet(3)
    const baseDir = mkdir()
    let rpc = null
    const platform = createNodePlatform({
        argv: [baseDir, '', '', ''],
        storageNamespace: 'healtest2',
        bootstrap: testnet.bootstrap,
        leaseTtlMs: 60000,
        reply: () => JSON.stringify({ stored: true }),
        createRpc: (handler) => { rpc = createNodeRpc(handler, [], () => JSON.stringify({ stored: true })); return rpc },
    })
    let handle = null
    try {
        handle = await startBackend(platform)
        // Poison the personal registry: 'default' points at a base we cannot open.
        const FOREIGN = 'b'.repeat(64)
        assert.equal(await updateItem(buildListMetaItem({ id: 'default', name: 'Spesa', type: 'shopping', baseKey: FOREIGN, updatedAt: Date.now() })), true)
        await autobase.update()
        assert.equal(reduceRegistry(await rebuildAllItems()).lists.find((l) => l.id === 'default').baseKey, FOREIGN)

        // A write to 'default' — even carrying the foreign baseKey explicitly —
        // must succeed (land in the personal base), not be refused/misrouted.
        const reply = await rpc.dispatch(RPC_ADD, JSON.stringify({ text: 'Latte', listId: 'default', listType: 'shopping', baseKey: FOREIGN }))
        assert.equal(JSON.parse(reply).ok, true, 'built-in write is not refused by the poisoned route')
        await autobase.update()
        const landed = (await rebuildAllItems()).filter((i) => i.listId === 'default' && i.text === 'Latte')
        assert.equal(landed.length, 1, 'the item landed in the personal default list')
    } finally {
        if (handle?.shutdown) { try { await handle.shutdown() } catch (_) {} }
        try { await testnet.destroy() } catch (_) {}
    }
})
