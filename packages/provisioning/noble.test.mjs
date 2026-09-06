import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { openLeafTransport } from './transport/noble.mjs'
import { CHAR_CONFIG_UUID, CHAR_STATUS_UUID } from './index.mjs'

function adapter() {
    const noble = new EventEmitter()
    noble.state = 'poweredOn'
    noble.stops = 0
    noble.stopScanningAsync = async () => { noble.stops++ }
    return noble
}

test('failed filtered and unfiltered scans remove listeners immediately', async () => {
    const noble = adapter()
    noble.startScanningAsync = async () => { throw new Error('scan rejected') }
    await assert.rejects(openLeafTransport({ noble, timeoutMs: 100, logger: null }), /scan rejected/)
    assert.equal(noble.listenerCount('discover'), 0)
})

test('a stalled scan stop cannot prevent the deadline returning', { timeout: 1000 }, async () => {
    const noble = adapter()
    noble.stopScanningAsync = () => new Promise(() => {})
    noble.startScanningAsync = async () => {}
    await assert.rejects(openLeafTransport({ noble, timeoutMs: 20, logger: null }), /timed out/)
    assert.equal(noble.listenerCount('discover'), 0)
})

test('an adapter that never powers on releases its listener at the deadline', async () => {
    const noble = adapter()
    noble.state = 'poweredOff'
    await assert.rejects(openLeafTransport({ noble, timeoutMs: 20, logger: null }), /timed out/)
    assert.equal(noble.listenerCount('stateChange'), 0)
})

test('a connection completing after timeout is disconnected without discovery', async () => {
    const noble = adapter()
    let finishConnect
    let disconnects = 0
    let discoveries = 0
    const peripheral = {
        advertisement: { localName: 'listam-leaf-test' },
        connectAsync: () => new Promise((resolve) => { finishConnect = resolve }),
        disconnectAsync: async () => { disconnects++ },
        discoverSomeServicesAndCharacteristicsAsync: async () => { discoveries++ },
    }
    noble.startScanningAsync = async () => { queueMicrotask(() => noble.emit('discover', peripheral)) }
    await assert.rejects(openLeafTransport({ noble, timeoutMs: 20, logger: null }), /timed out/)
    finishConnect()
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(disconnects >= 2, 'disconnect is retried when the late native connect finishes')
    assert.equal(discoveries, 0)
})

test('closing a transport detaches a stalled subscription and refuses stale operations', async () => {
    const noble = adapter()
    const status = new EventEmitter()
    status.uuid = CHAR_STATUS_UUID.replaceAll('-', '')
    let subscribed
    status.subscribeAsync = () => new Promise((resolve) => { subscribed = resolve })
    status.unsubscribeAsync = async () => {}
    const config = { uuid: CHAR_CONFIG_UUID.replaceAll('-', ''), writeAsync: async () => {} }
    const peripheral = {
        advertisement: { localName: 'listam-leaf-test' },
        connectAsync: async () => {}, disconnectAsync: async () => {},
        discoverSomeServicesAndCharacteristicsAsync: async () => ({ characteristics: [status, config] }),
    }
    noble.startScanningAsync = async () => { queueMicrotask(() => noble.emit('discover', peripheral)) }
    const transport = await openLeafTransport({ noble, logger: null })
    const pending = transport.subscribe(CHAR_STATUS_UUID, () => {})
    assert.equal(status.listenerCount('data'), 1)
    await transport.close()
    assert.equal(status.listenerCount('data'), 0)
    subscribed()
    await assert.rejects(pending, /closed/)
    await assert.rejects(transport.write(CHAR_CONFIG_UUID, new Uint8Array()), /closed/)
    await assert.rejects(transport.subscribe(CHAR_STATUS_UUID, () => {}), /closed/)
})
