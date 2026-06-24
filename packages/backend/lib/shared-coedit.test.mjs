import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { setBackendFs } from './platform-fs.mjs'
import { createBaseContext } from './base-context.mjs'
import {
    openSharedBase,
    closeSharedBase,
    bootstrapSharedOwner,
    setupSharedPairing,
    createSharedInvite,
    seedSharedBase,
    joinSharedBaseViaInvite,
} from './shared-base.mjs'
import { addItem } from './item.mjs'

setBackendFs(fs)

function mkdir () {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'listam-coedit-'))
}

async function waitFor (predicate, { deadlineMs = 30000, stepMs = 250, onTick } = {}) {
    const deadline = Date.now() + deadlineMs
    for (;;) {
        if (onTick) await onTick()
        if (await predicate()) return true
        if (Date.now() >= deadline) return false
        await new Promise((r) => setTimeout(r, stepMs))
    }
}

const texts = (ctx) => ctx.currentList.map((i) => i.text).sort()

// End-to-end co-edit of a SHARED single-list base on a private DHT: owner A
// bootstraps the base + seeds it + mints an invite; B joins additively and
// becomes a writer; both edit and converge (LWW), proving the
// SHARE_LIST/JOIN_LIST engine path (without the app RPC layer). This is the
// shared-base analogue of the desktop personal sync regression test.
test('shared base: A shares + seeds, B joins as writer, both edit, converges', async (t) => {
    t.diagnostic('starting private DHT testnet')
    const testnet = await createTestnet(3)
    const bootstrap = testnet.bootstrap
    const dirA = mkdir()
    const dirB = mkdir()

    const ctxA = createBaseContext({ role: 'shared' })
    let ctxB = null
    try {
        // --- Owner A: bootstrap + seed + invite ---
        await openSharedBase(ctxA, { storageDir: dirA, bootstrap })
        await bootstrapSharedOwner(ctxA)
        assert.equal(ctxA.membershipState.ownerAuthorityKey != null, true, 'A is owner')
        assert.equal(ctxA.autobase.writable, true)
        setupSharedPairing(ctxA)
        await seedSharedBase(ctxA, [
            { id: 'm1', text: 'Milk', isDone: false, timeOfCompletion: 0, listId: 'default', listType: 'shopping', updatedAt: 1 },
        ])
        assert.deepEqual(texts(ctxA), ['Milk'])

        const invite = createSharedInvite(ctxA)
        assert.ok(invite && typeof invite === 'string', 'invite minted')

        // --- B: additive join → becomes a writer ---
        const joined = await joinSharedBaseViaInvite(createBaseContext, { invite, storageDir: dirB, bootstrap })
        ctxB = joined.ctx
        assert.equal(joined.baseKeyHex, ctxA.baseId, 'B joined the SAME base')
        assert.equal(joined.writable, true, 'B became a writer')

        // B sees the seeded item via replication.
        const sawSeed = await waitFor(async () => texts(ctxB).includes('Milk'), {
            onTick: async () => { try { await ctxB.autobase.update() } catch (_) {} },
        })
        assert.equal(sawSeed, true, 'B replicated the seeded Milk')

        // --- Both edit; the bases converge (LWW) ---
        assert.equal(await addItem('Eggs', 'default', 'shopping', null, ctxA), true)
        assert.equal(await addItem('Bread', 'default', 'shopping', null, ctxB), true)

        const want = ['Bread', 'Eggs', 'Milk']
        const converged = await waitFor(async () => {
            try { await ctxA.autobase.update(); await ctxB.autobase.update() } catch (_) {}
            return JSON.stringify(texts(ctxA)) === JSON.stringify(want) &&
                   JSON.stringify(texts(ctxB)) === JSON.stringify(want)
        })
        assert.equal(converged, true, `bases converged; A=${texts(ctxA)} B=${texts(ctxB)}`)
    } finally {
        if (ctxB) await closeSharedBase(ctxB)
        await closeSharedBase(ctxA)
        await testnet.destroy()
    }
})
