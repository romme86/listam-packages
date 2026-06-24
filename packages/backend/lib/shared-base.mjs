// The lifecycle of a SHARED single-list base, opened ALONGSIDE the personal base.
//
// It mirrors the personal base's setup in network.mjs (Corestore + Autobase +
// Hyperswarm topic + replication), but everything lives on the passed-in
// BaseContext, and apply() is BOUND to that ctx — so this base reduces
// independently of the personal base and any other shared base (their async
// apply/swarm callbacks interleave). Storage is namespaced per base.
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { apply, open, swarmBootstrap } from '../backend.mjs'
import { logger } from './logger.mjs'

// Open (and, by default, start replicating) a shared base into `ctx`.
//   baseKey = null  → bootstrap a fresh base (this device is the first writer).
//   baseKey set     → open an existing shared base and replicate it.
// `storageDir` is the per-base Corestore directory. `joinSwarm:false` opens the
// base without networking (used by unit tests).
export async function openSharedBase (ctx, { baseKey = null, encryptionKey = null, storageDir, bootstrap = swarmBootstrap, joinSwarm = true } = {}) {
    if (!storageDir) throw new Error('openSharedBase requires a storageDir')

    ctx.store = new Corestore(storageDir)
    await ctx.store.ready()
    ctx.autobase = new Autobase(ctx.store, baseKey, {
        apply: (nodes, view, host) => apply(ctx, nodes, view, host),
        open,
        valueEncoding: 'json',
        encrypt: true,
        encryptionKey: encryptionKey || undefined,
    })
    await ctx.autobase.ready()
    ctx.baseKey = ctx.autobase.key
    ctx.encryptionKey = ctx.autobase.encryptionKey
    ctx.baseId = b4a.toString(ctx.autobase.key, 'hex')
    await ctx.autobase.update()

    if (joinSwarm) {
        ctx.swarm = new Hyperswarm(bootstrap ? { bootstrap } : {})
        ctx.swarm.on('error', (err) => logger.log('[ERROR] Shared-base swarm error:', err))
        ctx.swarm.on('connection', (conn) => {
            conn.on('error', () => {})
            ctx.peerCount = ctx.swarm.connections.size
            if (ctx.autobase) ctx.autobase.replicate(conn)
            conn.on('close', () => { ctx.peerCount = ctx.swarm.connections.size })
        })
        ctx.discovery = ctx.swarm.join(ctx.autobase.discoveryKey, { server: true, client: true })
        await ctx.discovery.flushed()
    }
    logger.log('[INFO] Opened shared base', { baseId: ctx.baseId.slice(0, 16), writable: ctx.autobase.writable })
    return ctx
}

export async function closeSharedBase (ctx) {
    try { if (ctx.discovery) await ctx.discovery.destroy() } catch (e) { logger.log('[ERROR] shared close discovery:', e) }
    try { if (ctx.swarm) await ctx.swarm.destroy() } catch (e) { logger.log('[ERROR] shared close swarm:', e) }
    try { if (ctx.autobase) await ctx.autobase.close() } catch (e) { logger.log('[ERROR] shared close autobase:', e) }
    try { if (ctx.store) await ctx.store.close() } catch (e) { logger.log('[ERROR] shared close store:', e) }
    ctx.discovery = null
    ctx.swarm = null
    ctx.autobase = null
    ctx.store = null
}
