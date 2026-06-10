import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createBackendPaths,
    createNodePlatform,
    startBackend,
} from './index.mjs'

test('@listam/backend imports under Node without BareKit globals', () => {
    assert.equal(globalThis.Bare, undefined)
    assert.equal(globalThis.BareKit, undefined)
    assert.equal(typeof startBackend, 'function')
})

test('@listam/backend resolves Node platform paths', () => {
    const platform = createNodePlatform({
        argv: ['file:///tmp/listam-phase-8', 'peer-a,peer-b', 'abcd', '{"secrets":{}}'],
    })
    const paths = createBackendPaths(platform)

    assert.equal(paths.storagePath, '/tmp/listam-phase-8/lista')
    assert.equal(paths.peerKeysString, 'peer-a,peer-b')
    assert.equal(paths.baseKeyHex, 'abcd')
    assert.equal(paths.bootSecretPayload, '{"secrets":{}}')
    assert.equal(paths.keyFilePath, '/tmp/listam-phase-8/lista-autobase-key.txt')
})

test('@listam/backend Node RPC adapter dispatches requests and records sends', async () => {
    const seen = []
    const platform = createNodePlatform()
    const rpc = platform.createRpc(async (req) => {
        seen.push({ command: req.command, data: req.data.toString() })
        req.reply('ack')
    })

    const reply = await rpc.dispatch(42, 'hello')
    rpc.request(7).send('backend-event')

    assert.equal(reply, 'ack')
    assert.deepEqual(seen, [{ command: 42, data: 'hello' }])
    assert.deepEqual(platform.sent, [{ command: 7, data: 'backend-event' }])
    assert.equal(await rpc.request(13).reply(), JSON.stringify({ stored: false, mode: 'node-memory' }))
})
