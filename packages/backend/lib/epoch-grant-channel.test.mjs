import test from 'node:test'
import assert from 'node:assert/strict'
import SecretStream from '@hyperswarm/secret-stream'
import { createEpochGrantChannel } from './epoch-grant-channel.mjs'

function connectedNoisePair() {
    const a = new SecretStream(true)
    const b = new SecretStream(false)
    a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
    return { a, b }
}

test('direct epoch grant waits for the peer adoption acknowledgement', async (t) => {
    const { a, b } = connectedNoisePair()
    t.after(() => { a.destroy(); b.destroy() })
    let received = null
    const sender = createEpochGrantChannel(a, { onGrant: async () => false, timeoutMs: 1000 })
    createEpochGrantChannel(b, {
        timeoutMs: 1000,
        onGrant: async (record) => {
            received = record
            return true
        },
    })

    const record = { type: 'membership', action: 'resync-epoch', signature: 'signed' }
    assert.equal(await sender.sendGrant(record), true)
    assert.deepEqual(received, record)
})

test('direct epoch grant reports a peer validation rejection', async (t) => {
    const { a, b } = connectedNoisePair()
    t.after(() => { a.destroy(); b.destroy() })
    const sender = createEpochGrantChannel(a, { onGrant: async () => false, timeoutMs: 1000 })
    createEpochGrantChannel(b, { onGrant: async () => false, timeoutMs: 1000 })
    assert.equal(await sender.sendGrant({ type: 'membership' }), false)
})
