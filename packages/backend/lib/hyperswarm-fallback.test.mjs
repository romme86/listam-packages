import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import Hyperswarm from 'hyperswarm'
import DHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import { createRelayThrough } from './relay.mjs'

// Exercise the installed Hyperswarm recovery policy, with deterministic dial
// failures. The separate relay-check integration test proves actual forwarding.
test('Hyperswarm retries CANNOT_HOLEPUNCH through alternating Listam relays', { timeout: 15000 }, async (t) => {
    const network = await createTestnet(3)
    const keys = [DHT.keyPair().publicKey, DHT.keyPair().publicKey]
    const swarm = new Hyperswarm({ bootstrap: network.bootstrap, relayThrough: createRelayThrough(keys) })
    t.after(async () => { await swarm.destroy(); await network.destroy() })
    const attempts = []
    swarm.dht.connect = (publicKey, options) => {
        attempts.push(options.relayThrough)
        const connection = new EventEmitter()
        connection.remotePublicKey = publicKey
        setImmediate(() => {
            connection.emit('error', Object.assign(new Error('injected unreachable path'), { code: 'CANNOT_HOLEPUNCH' }))
            connection.emit('close')
        })
        return connection
    }
    const peer = swarm._upsertPeer(DHT.keyPair().publicKey)
    for (let i = 0; i < 3; i++) {
        swarm._connect(peer, false)
        await once(swarm, 'update')
        assert.equal(swarm._allConnections.size, 0)
        assert.equal(peer.forceRelaying, true)
    }
    assert.equal(attempts[0], null)
    assert.ok(keys.includes(attempts[1]))
    assert.ok(keys.includes(attempts[2]))
    assert.notDeepEqual(attempts[1], attempts[2], 'one unavailable relay cannot monopolize retries')
})
