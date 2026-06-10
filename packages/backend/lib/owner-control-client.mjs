// Mobile owner-control client (Phase 14/15), running inside the Bare worklet
// where the hyperdht stack already lives. The React Native frontend drives it
// over RPC; this module dials a paired headless instance's control address,
// pairs once with an operator-minted code, and sends signed,
// capability-scoped commands through the shared @listam/owner-control session.
//
// The device identity seed is service material persisted through the same
// secure-storage boundary as the list keys (the new `controlDeviceSeed`
// secret name); the paired-server list is non-secret metadata kept in memory
// and surfaced to the frontend, which persists it as a local preference.
import DHT from 'hyperdht'
import b4a from 'b4a'
import { randomBytes } from 'hypercore-crypto'
import {
    createDeviceKeyPair,
    createOwnerControlSession,
    parsePairingCode,
} from '@listam/owner-control'
import { secretStoreKey } from '@listam/secrets'

const REQUEST_TIMEOUT_MS = 30_000

// `deps` is injected so the client is testable without the BareKit globals:
// { createDht, loadControlSeed, saveControlSeed, logger }. createDht lets a
// test bind the client to a private testnet; production uses the default.
export function createOwnerControlClient(deps) {
    const dht = typeof deps.createDht === 'function' ? deps.createDht() : new DHT()
    let deviceKeyPair = null
    let servers = []

    async function ensureDeviceKeyPair() {
        if (deviceKeyPair) return deviceKeyPair
        let seedHex = await deps.loadControlSeed()
        if (!seedHex) {
            seedHex = randomBytes(32).toString('hex')
            const stored = await deps.saveControlSeed(seedHex)
            if (!stored) {
                // Could not durably persist; use an ephemeral identity for this
                // session rather than failing outright.
                deps.logger?.log?.('[WARNING] Owner-control device seed not durably stored; using a session identity')
            }
        }
        deviceKeyPair = createDeviceKeyPair(seedHex)
        return deviceKeyPair
    }

    async function withSession(serverPublicKeyHex, run) {
        const keyPair = await ensureDeviceKeyPair()
        const socket = dht.connect(b4a.from(serverPublicKeyHex, 'hex'))
        socket.on('error', () => {})
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('control connection timed out')), REQUEST_TIMEOUT_MS)
            socket.once('open', () => { clearTimeout(timer); resolve() })
            socket.once('close', () => { clearTimeout(timer); reject(new Error('control connection closed')) })
        })
        const session = createOwnerControlSession({ keyPair, write: (line) => socket.write(line + '\n') })
        let buffered = ''
        socket.on('data', (chunk) => {
            buffered += b4a.toString(chunk)
            let newline = buffered.indexOf('\n')
            while (newline >= 0) {
                session.handleLine(buffered.slice(0, newline))
                buffered = buffered.slice(newline + 1)
                newline = buffered.indexOf('\n')
            }
        })
        try {
            return await withTimeout(run(session), REQUEST_TIMEOUT_MS)
        } finally {
            socket.destroy()
        }
    }

    return {
        async deviceId() {
            const keyPair = await ensureDeviceKeyPair()
            return createOwnerControlSession({ keyPair, write: () => {} }).deviceId
        },
        listServers() {
            return servers.map((server) => ({ ...server }))
        },
        setServers(list) {
            // Hydrate from the frontend's persisted preference on startup.
            if (!Array.isArray(list)) return
            servers = list
                .filter((entry) => /^[0-9a-f]{64}$/.test(entry?.serverPublicKeyHex ?? ''))
                .map((entry) => ({
                    serverPublicKeyHex: entry.serverPublicKeyHex,
                    name: typeof entry.name === 'string' ? entry.name : 'Headless device',
                    capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : [],
                }))
        },
        async pair(code, name) {
            const parsed = parsePairingCode(code)
            if (!parsed) return { ok: false, reason: 'invalid-code' }
            const result = await withSession(parsed.serverPublicKeyHex, (session) => session.pair(parsed.secretHex, name))
            if (result?.ok) {
                servers = [
                    ...servers.filter((entry) => entry.serverPublicKeyHex !== parsed.serverPublicKeyHex),
                    {
                        serverPublicKeyHex: parsed.serverPublicKeyHex,
                        name: typeof name === 'string' && name.trim() ? name.trim() : 'Headless device',
                        capabilities: result.capabilities ?? [],
                    },
                ]
            }
            return { ...result, servers: this.listServers() }
        },
        async command(serverPublicKeyHex, command, payload) {
            if (!/^[0-9a-f]{64}$/.test(serverPublicKeyHex ?? '')) return { ok: false, reason: 'unknown-server' }
            return withSession(serverPublicKeyHex, (session) => session.request(command, payload))
        },
        async close() {
            try {
                await dht.destroy()
            } catch {}
        },
    }
}

export function controlDeviceSeedStoreKey() {
    return secretStoreKey('controlDeviceSeed')
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('owner-control request timed out')), ms)
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value) },
            (error) => { clearTimeout(timer); reject(error) },
        )
    })
}
