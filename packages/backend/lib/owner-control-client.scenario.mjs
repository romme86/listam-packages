// The mobile owner-control client (worklet side) drives the shared
// @listam/owner-control session over a real hyperdht connection. This scenario
// stands up a minimal control server from the same protocol primitives the
// headless server uses, on a private testnet, and proves the client pairs,
// persists its device seed through the injected secret store, sends signed
// scoped commands, and is refused out-of-scope ones.
//
// Run as a plain child process by owner-control-client.test.mjs (hyperdht's
// post-teardown reset noise cannot be filtered narrowly under node:test).
import assert from 'node:assert/strict'
import process from 'node:process'
import readline from 'node:readline'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import {
    authorizeCommand,
    createDeviceRegistry,
    createPairingOffer,
    verifyPairingRequest,
} from '@listam/owner-control'
import { createOwnerControlClient } from './owner-control-client.mjs'

process.on('uncaughtException', (error) => {
    if (/connection reset by peer/i.test(error?.message ?? '')) return
    console.error(error)
    process.exit(1)
})
const mark = (label) => console.log(`OCCLIENT ${label}`)

// A compact stand-in for the headless control server: same authorization
// pipeline, enough surface to exercise the client.
async function startTestControlServer(bootstrap, capabilities) {
    const dht = new DHT({ bootstrap })
    const serverKeyPair = DHT.keyPair()
    const registry = createDeviceRegistry()
    const { code, offer } = createPairingOffer({ serverPublicKey: serverKeyPair.publicKey, capabilities, now: Date.now() })

    const server = dht.createServer((socket) => {
        socket.on('error', () => {})
        const rl = readline.createInterface({ input: socket })
        rl.on('line', (line) => {
            let message = null
            try {
                message = JSON.parse(line)
            } catch {
                return
            }
            if (message.type === 'pair') {
                const verified = verifyPairingRequest(message, offer, { now: Date.now() })
                if (verified.ok) {
                    offer.used = true
                    registry.addDevice({ ...verified.device, now: Date.now() })
                }
                socket.write(JSON.stringify({ type: 'pair-result', deviceId: message.deviceId, ok: verified.ok, reason: verified.reason, capabilities: verified.device?.capabilities }) + '\n')
                return
            }
            const authorized = authorizeCommand(registry, message, { now: Date.now() })
            socket.write(JSON.stringify(authorized.ok
                ? { commandId: message.commandId, ok: true, echo: message.command }
                : { commandId: message.commandId, ok: false, reason: authorized.reason }) + '\n')
        })
    })
    await server.listen(serverKeyPair)
    return { code, async close() { await server.close(); await dht.destroy() } }
}

const testnet = await createTestnet(3)
const server = await startTestControlServer(testnet.bootstrap, ['status:read'])

const secrets = new Map()
const client = createOwnerControlClient({
    createDht: () => new DHT({ bootstrap: testnet.bootstrap }),
    loadControlSeed: async () => secrets.get('seed') ?? null,
    saveControlSeed: async (seedHex) => { secrets.set('seed', seedHex); return true },
})

// First contact mints and persists a device seed.
const deviceId = await client.deviceId()
assert.match(deviceId, /^[0-9a-f]{64}$/)
assert.ok(secrets.has('seed'), 'device seed persisted through the injected secret store')

// Pairing registers the device with the server-granted capabilities.
const paired = await client.pair(server.code, 'Romme iPhone')
assert.equal(paired.ok, true)
assert.deepEqual(client.listServers()[0].capabilities, ['status:read'])
assert.equal(client.listServers()[0].name, 'Romme iPhone')
mark('paired')

// A granted command succeeds.
const serverKeyHex = client.listServers()[0].serverPublicKeyHex
const status = await client.command(serverKeyHex, 'status')
assert.equal(status.ok, true)
assert.equal(status.echo, 'status')

// An out-of-scope command is refused by the server.
const shutdown = await client.command(serverKeyHex, 'shutdown')
assert.equal(shutdown.ok, false)
assert.equal(shutdown.reason, 'out-of-scope')
mark('scoped-commands')

// The seed is stable: a fresh client with the same store has the same id.
const sameClient = createOwnerControlClient({
    createDht: () => new DHT({ bootstrap: testnet.bootstrap }),
    loadControlSeed: async () => secrets.get('seed') ?? null,
    saveControlSeed: async () => true,
})
assert.equal(await sameClient.deviceId(), deviceId, 'persisted seed yields a stable device identity')
await sameClient.close()
mark('stable-identity')

await client.close()
await server.close()
await testnet.destroy()
mark('complete')
process.exit(0)
