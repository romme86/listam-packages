import test from 'node:test'
import assert from 'node:assert/strict'
import {
    CAPABILITIES,
    COMMAND_TS_WINDOW_MS,
    applyRotation,
    authorizeCommand,
    canonicalJson,
    createCommandEnvelope,
    createDeviceKeyPair,
    createDeviceRegistry,
    createPairingOffer,
    createPairingRequest,
    createRotationPayload,
    deviceIdFromPublicKey,
    parsePairingCode,
    verifyPairingRequest,
} from './index.mjs'

const NOW = 1_700_000_000_000

function pairedRegistry(capabilities, keyPair = createDeviceKeyPair()) {
    const registry = createDeviceRegistry()
    registry.addDevice({
        deviceId: deviceIdFromPublicKey(keyPair.publicKey),
        name: 'test-device',
        capabilities,
        now: NOW,
    })
    return { registry, keyPair }
}

test('canonical JSON is stable across key insertion order', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } }),
        canonicalJson({ a: { c: 'x', d: [2, { y: 2, z: 1 }] }, b: 1 }))
    assert.equal(canonicalJson(undefined), 'null')
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
})

test('a signed command from a registered, in-scope device is accepted exactly once', () => {
    const { registry, keyPair } = pairedRegistry(['status:read'])
    const envelope = createCommandEnvelope({ keyPair, command: 'status', seq: 1, now: NOW })

    const first = authorizeCommand(registry, envelope, { now: NOW })
    assert.equal(first.ok, true)
    assert.equal(first.device.name, 'test-device')

    // The same envelope again is a replay (seq high-water mark persisted).
    const replayed = authorizeCommand(registry, envelope, { now: NOW + 10 })
    assert.equal(replayed.ok, false)
    assert.equal(replayed.reason, 'replay')

    // A lower seq from the same device is also a replay.
    const lower = createCommandEnvelope({ keyPair, command: 'status', seq: 1, now: NOW + 20 })
    assert.equal(authorizeCommand(registry, lower, { now: NOW + 20 }).reason, 'replay')

    // The next seq goes through.
    const next = createCommandEnvelope({ keyPair, command: 'status', seq: 2, now: NOW + 30 })
    assert.equal(authorizeCommand(registry, next, { now: NOW + 30 }).ok, true)
})

test('unsigned, tampered, expired, and unknown-device commands are refused', () => {
    const { registry, keyPair } = pairedRegistry(['status:read'])

    const unsigned = { ...createCommandEnvelope({ keyPair, command: 'status', seq: 1, now: NOW }) }
    delete unsigned.signature
    assert.equal(authorizeCommand(registry, unsigned, { now: NOW }).reason, 'unsigned')

    const tamperedPayload = createCommandEnvelope({ keyPair, command: 'status', seq: 1, now: NOW })
    tamperedPayload.payload = { sneaky: true }
    assert.equal(authorizeCommand(registry, tamperedPayload, { now: NOW }).reason, 'payload-hash-mismatch')

    const tamperedField = createCommandEnvelope({ keyPair, command: 'status', seq: 1, now: NOW })
    tamperedField.seq = 99
    assert.equal(authorizeCommand(registry, tamperedField, { now: NOW }).reason, 'bad-signature')

    const expired = createCommandEnvelope({ keyPair, command: 'status', seq: 1, now: NOW - COMMAND_TS_WINDOW_MS - 1 })
    assert.equal(authorizeCommand(registry, expired, { now: NOW }).reason, 'expired')

    const future = createCommandEnvelope({ keyPair, command: 'status', seq: 1, now: NOW + COMMAND_TS_WINDOW_MS + 1 })
    assert.equal(authorizeCommand(registry, future, { now: NOW }).reason, 'expired')

    const stranger = createCommandEnvelope({ keyPair: createDeviceKeyPair(), command: 'status', seq: 1, now: NOW })
    assert.equal(authorizeCommand(registry, stranger, { now: NOW }).reason, 'unknown-device')
})

test('capabilities are enforced per command: a diagnostics-only device cannot administer', () => {
    const { registry, keyPair } = pairedRegistry(['status:read', 'diagnostics:read'])

    assert.equal(authorizeCommand(registry, createCommandEnvelope({ keyPair, command: 'status', seq: 1, now: NOW }), { now: NOW }).ok, true)
    assert.equal(authorizeCommand(registry, createCommandEnvelope({ keyPair, command: 'diagnostics', seq: 2, now: NOW }), { now: NOW }).ok, true)

    for (const [seq, command] of [[3, 'shutdown'], [4, 'import'], [5, 'export'], [6, 'topics'], [7, 'invite']]) {
        const refused = authorizeCommand(registry, createCommandEnvelope({ keyPair, command, seq, now: NOW }), { now: NOW })
        assert.equal(refused.ok, false, `${command} must be refused`)
        assert.equal(refused.reason, 'out-of-scope')
    }
})

test('an envelope cannot claim a broader scope than its command', () => {
    const { registry, keyPair } = pairedRegistry([...CAPABILITIES])
    const envelope = createCommandEnvelope({ keyPair, command: 'status', seq: 1, now: NOW })
    envelope.scope = 'service:shutdown'
    assert.equal(authorizeCommand(registry, envelope, { now: NOW }).reason, 'scope-mismatch')
})

test('a revoked device is refused everything', () => {
    const { registry, keyPair } = pairedRegistry([...CAPABILITIES])
    const deviceId = deviceIdFromPublicKey(keyPair.publicKey)

    assert.equal(authorizeCommand(registry, createCommandEnvelope({ keyPair, command: 'status', seq: 1, now: NOW }), { now: NOW }).ok, true)
    assert.equal(registry.revokeDevice(deviceId, NOW).ok, true)
    const refused = authorizeCommand(registry, createCommandEnvelope({ keyPair, command: 'status', seq: 2, now: NOW }), { now: NOW })
    assert.equal(refused.reason, 'revoked-device')
})

test('a device rotates its own key; the old key dies and the new one cannot replay', () => {
    const { registry, keyPair: oldKey } = pairedRegistry(['status:read'])
    const newKey = createDeviceKeyPair()

    // Burn some sequence numbers on the old key first.
    authorizeCommand(registry, createCommandEnvelope({ keyPair: oldKey, command: 'status', seq: 5, now: NOW }), { now: NOW })

    const rotate = createCommandEnvelope({ keyPair: oldKey, command: 'rotate', payload: createRotationPayload(newKey), seq: 6, now: NOW })
    const authorized = authorizeCommand(registry, rotate, { now: NOW })
    assert.equal(authorized.ok, true)
    assert.equal(applyRotation(registry, rotate, { now: NOW }).ok, true)

    // Old key refused, new key inherits the seq high-water mark.
    const oldAfter = authorizeCommand(registry, createCommandEnvelope({ keyPair: oldKey, command: 'status', seq: 7, now: NOW }), { now: NOW })
    assert.equal(oldAfter.reason, 'revoked-device')
    const newReplay = authorizeCommand(registry, createCommandEnvelope({ keyPair: newKey, command: 'status', seq: 6, now: NOW }), { now: NOW })
    assert.equal(newReplay.reason, 'replay')
    const newFresh = authorizeCommand(registry, createCommandEnvelope({ keyPair: newKey, command: 'status', seq: 7, now: NOW }), { now: NOW })
    assert.equal(newFresh.ok, true)
    assert.deepEqual(newFresh.device.capabilities, ['status:read'], 'capabilities carry over unchanged')
})

test('the registry round-trips through serialization with seq and revocation intact', () => {
    const { registry, keyPair } = pairedRegistry(['status:read'])
    authorizeCommand(registry, createCommandEnvelope({ keyPair, command: 'status', seq: 9, now: NOW }), { now: NOW })

    const restored = createDeviceRegistry(JSON.parse(JSON.stringify(registry.toJSON())))
    const replay = authorizeCommand(restored, createCommandEnvelope({ keyPair, command: 'status', seq: 9, now: NOW }), { now: NOW })
    assert.equal(replay.reason, 'replay', 'seq high-water mark survives restart')
    assert.equal(authorizeCommand(restored, createCommandEnvelope({ keyPair, command: 'status', seq: 10, now: NOW }), { now: NOW }).ok, true)
})

test('pairing bootstrap: the code is single-use, expiring, and binds server-chosen capabilities', () => {
    const serverKey = createDeviceKeyPair()
    const { code, offer } = createPairingOffer({
        serverPublicKey: serverKey.publicKey,
        capabilities: ['status:read', 'service:shutdown', 'not-a-real-cap'],
        now: NOW,
    })

    const parsed = parsePairingCode(code)
    assert.equal(parsed.serverPublicKeyHex, deviceIdFromPublicKey(serverKey.publicKey))
    assert.equal(parsePairingCode('garbage'), null)

    const device = createDeviceKeyPair()
    const request = createPairingRequest({ keyPair: device, secretHex: parsed.secretHex, name: 'Romme laptop', now: NOW })
    const verified = verifyPairingRequest(request, offer, { now: NOW })
    assert.equal(verified.ok, true)
    assert.deepEqual(verified.device.capabilities, ['status:read', 'service:shutdown'], 'unknown capability names are dropped')
    assert.equal(verified.device.name, 'Romme laptop')

    // Wrong secret refused; expiry refused; used offer refused.
    const wrong = createPairingRequest({ keyPair: device, secretHex: 'ff'.repeat(32), name: 'x', now: NOW })
    assert.equal(verifyPairingRequest(wrong, offer, { now: NOW }).reason, 'pairing-secret-mismatch')
    assert.equal(verifyPairingRequest(request, offer, { now: NOW + 11 * 60_000 }).reason, 'pairing-expired')
    offer.used = true
    assert.equal(verifyPairingRequest(request, offer, { now: NOW }).reason, 'pairing-used')
})

test('pairing requests are bound to the device key by signature', () => {
    const serverKey = createDeviceKeyPair()
    const { code, offer } = createPairingOffer({ serverPublicKey: serverKey.publicKey, capabilities: ['status:read'], now: NOW })
    const parsed = parsePairingCode(code)

    const request = createPairingRequest({ keyPair: createDeviceKeyPair(), secretHex: parsed.secretHex, name: 'a', now: NOW })
    request.deviceId = deviceIdFromPublicKey(createDeviceKeyPair().publicKey) // claim another key
    assert.equal(verifyPairingRequest(request, offer, { now: NOW }).reason, 'bad-signature')
})
