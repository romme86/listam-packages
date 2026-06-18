import test from 'node:test'
import assert from 'node:assert/strict'
import {
    SERVICE_UUID,
    CHAR_CONFIG_UUID,
    CHAR_STATUS_UUID,
    PROVISIONING_PAYLOAD_VERSION,
    MAX_WIFI_NETWORKS,
    DEFAULT_MTU,
    FRAME_BEGIN,
    FRAME_CHUNK,
    FRAME_COMMIT,
    STATUS,
    statusName,
    isErrorStatus,
    isHex32,
    crc16,
    buildProvisioningPayload,
    validateProvisioningPayload,
    encodePayload,
    decodePayload,
    chunkPayload,
    reassemble,
    provisionLeaf,
} from './index.mjs'

const KEY = 'a'.repeat(64)

function fullPayload(overrides = {}) {
    return buildProvisioningPayload({
        controlKey: KEY,
        hubAddr: '192.168.1.67:9993,172.20.10.7:9993',
        wifi: [
            { ssid: 'Sunrise_1012493', psk: 'hfVkzjnyj5Bdrdsc' },
            { ssid: 'daidaidaidai', psk: 'prachbq79zzzz' },
        ],
        audioAddr: '192.168.1.67:9994',
        wakeDbThreshold: -30,
        ledGpio: 48,
        ...overrides,
    })
}

test('identifiers are valid 128-bit UUIDs', () => {
    for (const u of [SERVICE_UUID, CHAR_CONFIG_UUID, CHAR_STATUS_UUID]) {
        assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    }
})

test('buildProvisioningPayload normalizes and clamps', () => {
    const p = buildProvisioningPayload({
        controlKey: KEY.toUpperCase(),
        hubAddr: '  host:9993  ',
        wifi: [{ ssid: 'a' }, { ssid: 'b' }, { ssid: 'c' }, { ssid: 'd' }],
    })
    assert.equal(p.v, PROVISIONING_PAYLOAD_VERSION)
    assert.equal(p.control_key, KEY) // lowercased
    assert.equal(p.hub_addr, 'host:9993') // trimmed
    assert.equal(p.wifi.length, MAX_WIFI_NETWORKS) // clamped to 3
    assert.equal(p.audio_addr, undefined) // optional omitted
})

test('encode -> decode round-trips a full payload', () => {
    const p = fullPayload()
    const bytes = encodePayload(p)
    assert.ok(bytes instanceof Uint8Array)
    const back = decodePayload(bytes)
    assert.deepEqual(back, p)
})

test('validate rejects a non-64-hex control_key', () => {
    assert.throws(() => validateProvisioningPayload(fullPayload({ controlKey: 'deadbeef' })), /control_key/)
    assert.equal(isHex32('xyz'), false)
    assert.equal(isHex32(KEY), true)
})

test('validate rejects missing wifi', () => {
    const p = fullPayload()
    p.wifi = []
    assert.throws(() => validateProvisioningPayload(p), /wifi/)
})

test('validate rejects a wrong/absent version', () => {
    const p = fullPayload()
    p.v = 2
    assert.throws(() => validateProvisioningPayload(p), /version/)
})

test('validate rejects missing hub_addr', () => {
    const p = fullPayload()
    p.hub_addr = ''
    assert.throws(() => validateProvisioningPayload(p), /hub_addr/)
})

test('chunk -> reassemble is lossless across MTUs', () => {
    const bytes = encodePayload(fullPayload())
    for (const mtu of [DEFAULT_MTU, 23, 64, 247]) {
        const frames = chunkPayload(bytes, mtu)
        for (const f of frames) assert.ok(f.length <= mtu, `frame ${f.length} <= mtu ${mtu}`)
        assert.equal(frames[0][0], FRAME_BEGIN)
        assert.equal(frames[frames.length - 1][0], FRAME_COMMIT)
        const r = reassemble(frames)
        assert.ok(r.ok, r.error)
        assert.deepEqual(r.payload, bytes)
    }
})

test('reassemble detects a corrupted chunk via CRC', () => {
    const bytes = encodePayload(fullPayload())
    const frames = chunkPayload(bytes, 32)
    // flip a payload byte inside the first CHUNK frame
    const chunk = frames.find((f) => f[0] === FRAME_CHUNK)
    chunk[3] ^= 0xff
    const r = reassemble(frames)
    assert.equal(r.ok, false)
    assert.match(r.error, /crc|incomplete/)
})

test('crc16 matches CCITT-FALSE check vector', () => {
    // "123456789" -> 0x29B1 for CRC16/CCITT-FALSE
    assert.equal(crc16(new TextEncoder().encode('123456789')), 0x29b1)
})

test('status helpers', () => {
    assert.equal(statusName(STATUS.OK), 'OK')
    assert.equal(isErrorStatus(STATUS.OK), false)
    assert.equal(isErrorStatus(STATUS.ERR_CRC), true)
})

function makeFakeTransport({ respondWith = STATUS.OK, mtu = DEFAULT_MTU } = {}) {
    const writes = []
    let handler = null
    return {
        mtu,
        writes,
        async write(uuid, bytes) {
            writes.push({ uuid, bytes: Uint8Array.from(bytes) })
            if (bytes[0] === FRAME_COMMIT && handler) {
                // mimic the leaf: validate, then notify a single status byte
                queueMicrotask(() => handler(new Uint8Array([respondWith])))
            }
        },
        async subscribe(uuid, onValue) {
            handler = onValue
            return () => {
                handler = null
            }
        },
    }
}

test('provisionLeaf writes framed config and resolves on OK', async () => {
    const t = makeFakeTransport()
    const seen = []
    const res = await provisionLeaf({
        transport: t,
        payload: fullPayload(),
        onStatus: (code) => seen.push(code),
    })
    assert.deepEqual(res, { ok: true })
    assert.ok(seen.includes(STATUS.OK))
    // every config write targeted the config characteristic...
    for (const w of t.writes) assert.equal(w.uuid, CHAR_CONFIG_UUID)
    // ...and the bytes written reassemble back to the encoded payload.
    const r = reassemble(t.writes.map((w) => w.bytes))
    assert.ok(r.ok, r.error)
    assert.deepEqual(r.payload, encodePayload(fullPayload()))
})

test('provisionLeaf rejects on an error status', async () => {
    const t = makeFakeTransport({ respondWith: STATUS.ERR_CRC })
    await assert.rejects(
        provisionLeaf({ transport: t, payload: fullPayload() }),
        /ERR_CRC/,
    )
})

test('provisionLeaf times out without a response', async () => {
    const silent = {
        mtu: DEFAULT_MTU,
        async write() {},
        async subscribe() {
            return () => {}
        },
    }
    await assert.rejects(
        provisionLeaf({ transport: silent, payload: fullPayload(), timeoutMs: 50 }),
        /timed out/,
    )
})

test('provisionLeaf validates the transport contract', async () => {
    await assert.rejects(provisionLeaf({ transport: {}, payload: fullPayload() }), /transport/)
})
