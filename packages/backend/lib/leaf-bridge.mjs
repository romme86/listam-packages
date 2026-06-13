// TCP bridge for "leaf" peers (hardware/leaf-peer: leaf-host or the ESP32-S3
// firmware): replicates this app's corestore over plain TCP sockets and
// maintains a hub-written "leaf control core" that announces core keys for
// leaves to mirror.
//
// A leaf is a dumb, always-on replica: it stores and serves every announced
// core (writer oplogs, the autobase bootstrap, this control core) without
// understanding autobase or holding the encryption key. That gives the
// project extra availability and async message delivery while the other
// peers are offline.
//
// Leaves are provisioned once with the control core key printed at startup.
import b4a from 'b4a'
import { autobase, store } from './state.mjs'

const ENUMERATE_INTERVAL_MS = 10_000

// The bridge needs a TCP listener, but the runtime differs per app: Node's
// `net` in the headless peer, `bare-tcp` in the Pear desktop / mobile worklets
// (Bare has no `net`). The caller injects a net-compatible module via `tcp`
// (both expose `createServer(onConnection)` → server with `.listen`/`.close`,
// and bare-stream/net-Socket duplexes that `.pipe()`). Defaults to Node's
// `net` so the headless peer keeps working with no change.
async function resolveTcp(tcp) {
    if (tcp) return tcp
    const mod = await import('net')
    return mod.default ?? mod
}

// `onStatus` (optional) is called with `{ connections }` whenever a leaf
// connects or disconnects, so embedding UIs can show live bridge state.
export async function startLeafBridge({ port, host = '0.0.0.0', logger = console, tcp, onStatus } = {}) {
    if (!store) throw new Error('leaf-bridge: corestore not ready')
    const net = await resolveTcp(tcp)
    const control = store.get({ name: 'leaf-control' })
    await control.ready()

    // Seed the published set from existing entries so restarts do not
    // re-announce the same keys.
    const published = new Set()
    for (let i = 0; i < control.length; i++) {
        try {
            const entry = JSON.parse(b4a.toString(await control.get(i)))
            for (const key of entry.add ?? []) published.add(key)
        } catch {
            // tolerate malformed entries
        }
    }

    async function publish(keys) {
        const seen = new Set()
        const fresh = keys
            .map((key) => (b4a.isBuffer(key) ? b4a.toString(key, 'hex') : key))
            .filter((key) => {
                if (!key || published.has(key) || seen.has(key)) return false
                seen.add(key)
                return true
            })
        if (fresh.length === 0) return
        for (const key of fresh) published.add(key)
        await control.append(b4a.from(JSON.stringify({ add: fresh })))
        logger.log(`[leaf-bridge] announced ${fresh.length} core(s) to leaves`)
    }

    // The cores a leaf needs for availability: the autobase bootstrap, our
    // local writer, the system core, and every active writer oplog. Views
    // are derived locally by real peers, so they are not announced.
    async function enumerate() {
        if (!autobase) return
        const keys = []
        if (autobase.key) keys.push(autobase.key)
        if (autobase.local?.key) keys.push(autobase.local.key)
        try {
            if (autobase.core?.key) keys.push(autobase.core.key)
        } catch {
            // system core may not be ready yet
        }
        try {
            for (const writer of autobase.activeWriters ?? []) {
                const key = writer?.core?.key ?? writer?.key
                if (key) keys.push(key)
            }
        } catch {
            // activeWriters iteration is best-effort across autobase versions
        }
        await publish(keys)
    }

    await enumerate()
    const interval = setInterval(() => {
        enumerate().catch(() => {})
    }, ENUMERATE_INTERVAL_MS)
    if (typeof interval.unref === 'function') interval.unref()

    const sockets = new Set()
    const notifyStatus = () => {
        try {
            onStatus?.({ connections: sockets.size })
        } catch {
            // status listeners must never break replication
        }
    }
    const server = net.createServer((socket) => {
        // setNoDelay exists on Node sockets; bare-tcp sockets may not have it.
        socket.setNoDelay?.(true)
        const remote = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`
        logger.log(`[leaf-bridge] leaf connected from ${remote}`)
        sockets.add(socket)
        notifyStatus()
        const stream = store.replicate(false)
        // LISTAM_LEAF_BRIDGE_DEBUG=1: log per-chunk byte flow with timestamps,
        // to tell "leaf went silent" apart from "hub stopped answering" when
        // a leaf session wedges. Extra 'data' listeners do not disturb pipe().
        if (process.env.LISTAM_LEAF_BRIDGE_DEBUG) {
            const t0 = Date.now()
            let inBytes = 0
            let outBytes = 0
            socket.on('data', (chunk) => {
                inBytes += chunk.length
                logger.log(`[leaf-bridge] +${Date.now() - t0}ms ${remote} >> in ${chunk.length}B (total ${inBytes})`)
            })
            stream.on('data', (chunk) => {
                outBytes += chunk.length
                logger.log(`[leaf-bridge] +${Date.now() - t0}ms ${remote} << out ${chunk.length}B (total ${outBytes})`)
            })
        }
        socket.pipe(stream).pipe(socket)
        stream.on('error', (err) => {
            logger.log(`[leaf-bridge] replication stream error from ${remote}: ${err?.message ?? err}`)
            socket.destroy()
        })
        socket.on('error', (err) => {
            logger.log(`[leaf-bridge] socket error from ${remote}: ${err?.message ?? err}`)
            stream.destroy()
        })
        socket.on('close', () => {
            sockets.delete(socket)
            stream.destroy()
            logger.log(`[leaf-bridge] leaf disconnected ${remote}`)
            notifyStatus()
        })
    })

    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve())
    })

    const controlKey = b4a.toString(control.key, 'hex')
    logger.log(`[leaf-bridge] listening on ${host}:${port}`)
    logger.log(`[leaf-bridge] control core key (provision your leaf with this): ${controlKey}`)

    return {
        controlKey,
        port,
        connections: () => sockets.size,
        close: async () => {
            clearInterval(interval)
            for (const socket of sockets) socket.destroy()
            await new Promise((resolve) => server.close(resolve))
        },
    }
}
