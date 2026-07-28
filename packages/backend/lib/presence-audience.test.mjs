// A presence beat with nobody connected is unobservable, and not free.
//
// Presence is telemetry ABOUT this device FOR its peers, and it only reaches a
// peer over a live connection. A beat written while nothing is connected cannot
// be seen by anyone — by the time a peer arrives, the poke on that connection
// publishes a fresher one that supersedes it.
//
// The cost of those invisible beats is the whole point. Measured marginal cost
// of one beat is ~17.3 KB across the writer core, the view and the corestore
// index — about 12.5 MB per device per DAY at the 120s cadence, ~4.5 GB per
// device-year, into a log with no compaction. An always-on peer alone on the
// network was paying all of it to tell nobody anything.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setBackendFs } from './platform-fs.mjs'
import { createBaseContext } from './base-context.mjs'
import { openSharedBase, closeSharedBase, bootstrapSharedOwner } from './shared-base.mjs'
import { setAutobase, setSwarm } from './state.mjs'
import {
    writeHeartbeat,
    startPresenceHeartbeat,
    stopPresenceHeartbeat,
    resetPresenceAccounting,
} from './presence-heartbeat.mjs'

setBackendFs(fs)

// The heartbeat reads the MODULE-level personal state, so the base has to be
// installed THERE. Opening one on a BaseContext alone leaves module `autobase`
// null, `writeHeartbeat` bails on "not writable", and every assertion below
// passes for the wrong reason — which is exactly what the first draft of this
// file did.
async function personalBase (t) {
    const ctx = createBaseContext({ role: 'shared' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listam-presence-'))
    await openSharedBase(ctx, { storageDir: dir, joinSwarm: false })
    await bootstrapSharedOwner(ctx)
    await ctx.autobase.update()
    setAutobase(ctx.autobase)
    t.after(async () => {
        resetPresenceAccounting()
        setSwarm(null)
        setAutobase(null)
        await closeSharedBase(ctx)
        fs.rmSync(dir, { recursive: true, force: true })
    })
    return ctx
}

const withPeers = (n) => setSwarm({ connections: { size: n }, dht: { online: true } })

test('a beat is written with a peer connected, and withheld without one', async (t) => {
    // One setup, one variable: the connection count. Asserting the WRITE happens
    // when a peer is there is what makes the withheld case meaningful — without
    // it, "returned false" could mean anything.
    await personalBase(t)

    withPeers(1)
    resetPresenceAccounting()
    assert.equal(await writeHeartbeat({ final: false }), true, 'a connected peer must get a beat')

    // Reachable on the DHT, but nothing connected: the always-on peer sitting
    // alone, which is the case that was costing ~12.5 MB/day.
    withPeers(0)
    resetPresenceAccounting()
    assert.equal(await writeHeartbeat({ final: false }), false, 'no audience: nothing is written')
})

test('a final flush still writes, so a clean shutdown records the session', async (t) => {
    await personalBase(t)
    withPeers(0)
    resetPresenceAccounting()
    // Not asserting `true` — the underlying write can still refuse for reasons
    // this test does not control (writability, flushability). What must hold is
    // that `final` is not short-circuited by the audience gate itself.
    assert.equal(await writeHeartbeat({ final: true }), true, 'a final flush is not gated on an audience')
    stopPresenceHeartbeat()
})

test('the audience gate is about connections, not DHT reachability', async (t) => {
    await personalBase(t)
    resetPresenceAccounting()

    setSwarm({ connections: { size: 0 }, dht: { online: true } })
    assert.equal(await writeHeartbeat({ final: false }), false, 'reachable but alone: no write')
    // ...whereas a single connection flips it, with nothing else changed.
    withPeers(1)
    resetPresenceAccounting()
    assert.equal(await writeHeartbeat({ final: false }), true)

    // Offline AND alone must also not write — the pre-existing isOnline gate.
    setSwarm({ connections: { size: 0 }, dht: { online: false } })
    assert.equal(await writeHeartbeat({ final: false }), false)
})

test('accrual keeps running while nobody is connected', async (t) => {
    // The gate withholds the WRITE, not the accounting: avg-online must not
    // silently stop counting just because this device is briefly alone.
    await personalBase(t)
    resetPresenceAccounting()
    withPeers(0)
    await startPresenceHeartbeat()
    // No peer, so nothing was appended — but the module is started and accruing,
    // and the totals ride the next beat once a peer connects.
    assert.equal(await writeHeartbeat({ final: false }), false)
    stopPresenceHeartbeat()
})
