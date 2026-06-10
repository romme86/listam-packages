import assert from 'node:assert/strict'
import test from 'node:test'
import {
    decodeWithClientAdapter,
    nodeClientAdapter,
    workletClientAdapter,
} from './index.mjs'
import {
    RPC_ADD_FROM_BACKEND,
    RPC_DELETE_FROM_BACKEND,
    RPC_GET_KEY,
    RPC_MESSAGE,
    RPC_PERSIST_SECRET,
    RPC_RESET,
    RPC_UPDATE_FROM_BACKEND,
    SYNC_LIST,
} from '@listam/protocol'

const adapters = [workletClientAdapter, nodeClientAdapter]

for (const adapter of adapters) {
    test(`@listam/client backend event contract (${adapter.name})`, async (t) => {
        await t.test('decodes lifecycle and message events', () => {
            assert.deepEqual(decodeWithClientAdapter(adapter, RPC_RESET, '').type, 'reset')

            const message = decodeWithClientAdapter(adapter, RPC_MESSAGE, {
                type: 'join-success',
            })
            assert.equal(message.type, 'message')
            assert.deepEqual(message.payload, { type: 'join-success' })
        })

        await t.test('decodes list mutation events', () => {
            const item = { id: 'item-1', text: 'milk', listId: 'groceries' }
            const list = [item]

            assert.deepEqual(decodeWithClientAdapter(adapter, SYNC_LIST, list), {
                type: 'sync-list',
                items: list,
                raw: JSON.stringify(list),
            })
            assert.deepEqual(decodeWithClientAdapter(adapter, RPC_ADD_FROM_BACKEND, item).item, item)
            assert.deepEqual(decodeWithClientAdapter(adapter, RPC_UPDATE_FROM_BACKEND, item).item, item)
            assert.deepEqual(decodeWithClientAdapter(adapter, RPC_DELETE_FROM_BACKEND, item).item, item)
        })

        await t.test('decodes invite and secret persistence events', () => {
            const secretPayload = { op: 'persist', name: 'autobaseKey', value: '00' }

            assert.deepEqual(decodeWithClientAdapter(adapter, RPC_GET_KEY, 'invite-z32'), {
                type: 'invite-key',
                key: 'invite-z32',
            })
            assert.deepEqual(decodeWithClientAdapter(adapter, RPC_PERSIST_SECRET, secretPayload), {
                type: 'persist-secret',
                payload: JSON.stringify(secretPayload),
            })
        })
    })
}

// The desktop in-process channel must honor the same backend event contract as
// the worklet transport, plus the request/reply path secret persistence uses.
test('@listam/client backend channel (desktop in-process transport)', async (t) => {
    const { createBackendChannel } = await import('./index.mjs')

    await t.test('delivers backend-originated events decoded like the worklet adapter', () => {
        const channel = createBackendChannel()
        const received = []
        channel.client.onEvent((event) => received.push(event))

        const rpc = channel.platform.createRpc(async () => {})
        rpc.request(RPC_GET_KEY).send('invite-z32')
        rpc.request(SYNC_LIST).send(JSON.stringify([{ id: 'item-1', text: 'milk' }]))
        rpc.request(RPC_MESSAGE).send(JSON.stringify({ type: 'peer-count', count: 2 }))
        rpc.request(RPC_RESET).send('')

        assert.deepEqual(received.map((event) => event.type), ['invite-key', 'sync-list', 'message', 'reset'])
        assert.equal(received[0].key, 'invite-z32')
        assert.deepEqual(received[1].items, [{ id: 'item-1', text: 'milk' }])
        assert.deepEqual(received[2].payload, { type: 'peer-count', count: 2 })
    })

    await t.test('dispatches frontend commands into the backend handler with worklet-shaped requests', async () => {
        const channel = createBackendChannel()
        const seen = []
        channel.platform.createRpc(async (req) => {
            seen.push({ command: req.command, data: req.data.toString() })
            req.reply('ack')
        })

        const reply = await channel.client.send(7, { key: 'z32-invite' })
        assert.equal(reply, 'ack')
        assert.deepEqual(seen, [{ command: 7, data: JSON.stringify({ key: 'z32-invite' }) }])
    })

    await t.test('resolves backend reply() from an asynchronous listener reply (secret persistence ack)', async () => {
        const channel = createBackendChannel()
        channel.client.onEvent((event) => {
            if (event.type !== 'persist-secret') return
            setTimeout(() => event.reply(JSON.stringify({ stored: true })), 5)
        })

        const rpc = channel.platform.createRpc(async () => {})
        const req = rpc.request(RPC_PERSIST_SECRET)
        req.send(JSON.stringify({ op: 'set', name: 'autobaseKey' }))
        assert.equal(JSON.parse(await req.reply()).stored, true)
    })

    await t.test('reports connection state and unsubscribes listeners', async () => {
        const channel = createBackendChannel()
        assert.equal(channel.client.isConnected(), false)
        await assert.rejects(() => channel.client.send(2, 'milk'), /not connected/)

        const rpc = channel.platform.createRpc(async () => {})
        assert.equal(channel.client.isConnected(), true)

        const received = []
        const unsubscribe = channel.client.onEvent((event) => received.push(event))
        unsubscribe()
        rpc.request(RPC_RESET).send('')
        assert.equal(received.length, 0)

        rpc.close()
        assert.equal(channel.client.isConnected(), false)
    })
})
