// Owner-control protocol (finding H1): the authenticated-capability layer for
// commanding a headless Listam instance from the owner's other devices.
//
// Design rules, from the plan's H1 fix:
// - every command travels as a signed envelope carrying command id, device id,
//   capability scope, timestamp, per-device monotonic sequence, and a hash of
//   the payload — verified against a registered device key, never a bearer
//   token;
// - replay is rejected twice over: a timestamp window plus a persisted
//   per-device monotonic sequence (survives service restarts);
// - capabilities are separate grants fixed at pairing time by the code the
//   operator minted — a client cannot request broader scopes;
// - devices are individually revocable, and a registered device can rotate
//   its own key (the rotation is signed by the old key).
//
// This module is transport-agnostic pure logic: apps move envelopes over an
// encrypted hyperdht stream (or anything else) and call into here.
import { keyPair, sign, verify, hash, randomBytes } from 'hypercore-crypto'
import b4a from 'b4a'
import z32 from 'z32'

export const OWNER_CONTROL_VERSION = 1
export const COMMAND_TS_WINDOW_MS = 2 * 60_000
export const PAIRING_TTL_MS = 10 * 60_000

export const CAPABILITIES = Object.freeze([
    'status:read',
    'diagnostics:read',
    'topics:configure',
    'invite:create',
    'export:create',
    'import:apply',
    'service:shutdown',
])

// Self-rotation is an implicit right of every registered device (signed by
// the key being replaced); it is not a grantable capability.
export const ROTATE_SCOPE = 'device:rotate'

export const COMMAND_SCOPES = Object.freeze({
    status: 'status:read',
    diagnostics: 'diagnostics:read',
    topics: 'topics:configure',
    invite: 'invite:create',
    export: 'export:create',
    import: 'import:apply',
    shutdown: 'service:shutdown',
    rotate: ROTATE_SCOPE,
})

const HEX = /^[0-9a-f]+$/
const PUBLIC_KEY_BYTES = 32
const SECRET_BYTES = 32

// --- identity ---------------------------------------------------------------

export function createDeviceKeyPair(seed = null) {
    return seed ? keyPair(normalizeBuffer(seed, SECRET_BYTES)) : keyPair()
}

export function deviceIdFromPublicKey(publicKey) {
    return normalizeHex(publicKey, PUBLIC_KEY_BYTES)
}

// --- canonical encoding -----------------------------------------------------

// Deterministic JSON: object keys sorted at every depth, so a signature made
// on one runtime verifies on another regardless of insertion order.
export function canonicalJson(value) {
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
    if (typeof value === 'string') return JSON.stringify(value)
    if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    }
    return 'null'
}

export function payloadHashHex(payload) {
    return hash(b4a.from(canonicalJson(payload ?? null))).toString('hex')
}

// --- command envelopes ------------------------------------------------------

function envelopeSigningPayload(envelope) {
    return b4a.from(canonicalJson({
        v: envelope.v,
        commandId: envelope.commandId,
        deviceId: envelope.deviceId,
        command: envelope.command,
        scope: envelope.scope,
        ts: envelope.ts,
        seq: envelope.seq,
        payloadHash: envelope.payloadHash,
    }))
}

export function createCommandEnvelope({ keyPair: deviceKeyPair, command, payload = null, seq, now }) {
    const scope = COMMAND_SCOPES[command]
    if (!scope) throw new Error(`Unknown owner-control command: ${command}`)
    if (!Number.isFinite(seq) || seq <= 0) throw new Error('A positive monotonic seq is required')
    if (!Number.isFinite(now)) throw new Error('An explicit timestamp is required')

    const envelope = {
        v: OWNER_CONTROL_VERSION,
        commandId: randomBytes(16).toString('hex'),
        deviceId: deviceIdFromPublicKey(deviceKeyPair.publicKey),
        command,
        scope,
        ts: now,
        seq: Math.floor(seq),
        payloadHash: payloadHashHex(payload),
        payload: payload ?? null,
    }
    envelope.signature = sign(envelopeSigningPayload(envelope), deviceKeyPair.secretKey).toString('hex')
    return envelope
}

// Stateless envelope checks: shape, scope/command coherence, payload-hash
// integrity, timestamp freshness, and the signature against the envelope's
// own claimed device key. Registration, revocation, capability, and replay
// checks happen in authorizeCommand, against the registry.
export function verifyCommandEnvelope(envelope, { now, windowMs = COMMAND_TS_WINDOW_MS } = {}) {
    if (!envelope || typeof envelope !== 'object') return refused('malformed')
    if (Number(envelope.v) !== OWNER_CONTROL_VERSION) return refused('unsupported-version')
    if (typeof envelope.command !== 'string' || COMMAND_SCOPES[envelope.command] === undefined) return refused('unknown-command')
    if (envelope.scope !== COMMAND_SCOPES[envelope.command]) return refused('scope-mismatch')
    if (!isHex(envelope.commandId, 16)) return refused('malformed')
    if (!isHex(envelope.deviceId, PUBLIC_KEY_BYTES)) return refused('malformed')
    if (!Number.isFinite(envelope.ts) || !Number.isFinite(envelope.seq) || envelope.seq <= 0) return refused('malformed')
    if (envelope.payloadHash !== payloadHashHex(envelope.payload ?? null)) return refused('payload-hash-mismatch')
    if (!Number.isFinite(now)) return refused('no-reference-time')
    if (Math.abs(now - envelope.ts) > windowMs) return refused('expired')
    if (!isHex(envelope.signature, 64)) return refused('unsigned')

    const verified = verify(
        envelopeSigningPayload(envelope),
        b4a.from(envelope.signature, 'hex'),
        b4a.from(envelope.deviceId, 'hex'),
    )
    if (!verified) return refused('bad-signature')

    return { ok: true }
}

// --- device registry ----------------------------------------------------------

export function createDeviceRegistry(serialized = null) {
    const devices = new Map()

    if (serialized?.devices) {
        for (const entry of serialized.devices) {
            const deviceId = normalizeHex(entry?.deviceId, PUBLIC_KEY_BYTES)
            if (!deviceId) continue
            devices.set(deviceId, {
                deviceId,
                name: typeof entry.name === 'string' ? entry.name : 'device',
                capabilities: normalizeCapabilities(entry.capabilities),
                addedAt: Number(entry.addedAt) || 0,
                revokedAt: Number(entry.revokedAt) || null,
                rotatedTo: normalizeHex(entry.rotatedTo, PUBLIC_KEY_BYTES) || null,
                lastSeq: Number(entry.lastSeq) || 0,
            })
        }
    }

    return {
        addDevice({ deviceId, name, capabilities, now }) {
            const id = normalizeHex(deviceId, PUBLIC_KEY_BYTES)
            if (!id) return { ok: false, reason: 'malformed-device' }
            if (devices.has(id)) return { ok: false, reason: 'already-registered' }
            const device = {
                deviceId: id,
                name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : 'device',
                capabilities: normalizeCapabilities(capabilities),
                addedAt: now,
                revokedAt: null,
                rotatedTo: null,
                lastSeq: 0,
            }
            devices.set(id, device)
            return { ok: true, device }
        },
        getDevice(deviceId) {
            return devices.get(normalizeHex(deviceId, PUBLIC_KEY_BYTES) ?? '') ?? null
        },
        listDevices() {
            return [...devices.values()]
        },
        revokeDevice(deviceId, now) {
            const device = devices.get(normalizeHex(deviceId, PUBLIC_KEY_BYTES) ?? '')
            if (!device || device.revokedAt) return { ok: false, reason: 'unknown-device' }
            device.revokedAt = now
            return { ok: true, device }
        },
        rotateDevice(deviceId, newDeviceId, now) {
            const device = devices.get(normalizeHex(deviceId, PUBLIC_KEY_BYTES) ?? '')
            const newId = normalizeHex(newDeviceId, PUBLIC_KEY_BYTES)
            if (!device || device.revokedAt) return { ok: false, reason: 'unknown-device' }
            if (!newId) return { ok: false, reason: 'malformed-device' }
            if (devices.has(newId)) return { ok: false, reason: 'already-registered' }
            const rotated = {
                ...device,
                deviceId: newId,
                addedAt: now,
                // The new key must not be able to replay sequences the old key
                // already burned, so the high-water mark carries over.
            }
            device.revokedAt = now
            device.rotatedTo = newId
            devices.set(newId, rotated)
            return { ok: true, device: rotated }
        },
        recordSeq(deviceId, seq) {
            const device = devices.get(normalizeHex(deviceId, PUBLIC_KEY_BYTES) ?? '')
            if (device && seq > device.lastSeq) device.lastSeq = seq
        },
        toJSON() {
            return { version: OWNER_CONTROL_VERSION, devices: [...devices.values()] }
        },
    }
}

// Full authorization pipeline for one envelope against the registry.
export function authorizeCommand(registry, envelope, { now, windowMs = COMMAND_TS_WINDOW_MS } = {}) {
    const verified = verifyCommandEnvelope(envelope, { now, windowMs })
    if (!verified.ok) return verified

    const device = registry.getDevice(envelope.deviceId)
    if (!device) return refused('unknown-device')
    if (device.revokedAt) return refused('revoked-device')
    if (envelope.seq <= device.lastSeq) return refused('replay')

    const scope = COMMAND_SCOPES[envelope.command]
    if (scope !== ROTATE_SCOPE && !device.capabilities.includes(scope)) {
        return refused('out-of-scope')
    }

    registry.recordSeq(envelope.deviceId, envelope.seq)
    return { ok: true, device }
}

// --- pairing bootstrap --------------------------------------------------------

// The operator mints a single-use, short-lived pairing code on the headless
// device (Phase 13's stdin surface). The code carries the control server's
// public key plus a one-time secret; the capabilities are bound to the offer
// on the server side — the joining client cannot ask for more.
export function createPairingOffer({ serverPublicKey, capabilities, now, ttlMs = PAIRING_TTL_MS }) {
    const serverKeyHex = normalizeHex(serverPublicKey, PUBLIC_KEY_BYTES)
    if (!serverKeyHex) throw new Error('A 32-byte control server public key is required')
    if (!Number.isFinite(now)) throw new Error('An explicit timestamp is required')

    const secret = randomBytes(SECRET_BYTES)
    return {
        code: z32.encode(b4a.concat([b4a.from(serverKeyHex, 'hex'), secret])),
        offer: {
            secretHashHex: hash(secret).toString('hex'),
            capabilities: normalizeCapabilities(capabilities),
            expiresAt: now + ttlMs,
            used: false,
        },
    }
}

export function parsePairingCode(code) {
    try {
        const decoded = z32.decode(String(code).trim())
        if (decoded.byteLength !== PUBLIC_KEY_BYTES + SECRET_BYTES) return null
        return {
            serverPublicKeyHex: b4a.toString(decoded.subarray(0, PUBLIC_KEY_BYTES), 'hex'),
            secretHex: b4a.toString(decoded.subarray(PUBLIC_KEY_BYTES), 'hex'),
        }
    } catch {
        return null
    }
}

function pairingSigningPayload(request) {
    return b4a.from(canonicalJson({
        v: request.v,
        type: 'pair',
        deviceId: request.deviceId,
        name: request.name,
        ts: request.ts,
        secretHashHex: request.secretHashHex,
    }))
}

export function createPairingRequest({ keyPair: deviceKeyPair, secretHex, name, now }) {
    if (!isHex(secretHex, SECRET_BYTES)) throw new Error('A pairing secret is required')
    if (!Number.isFinite(now)) throw new Error('An explicit timestamp is required')

    const request = {
        v: OWNER_CONTROL_VERSION,
        type: 'pair',
        deviceId: deviceIdFromPublicKey(deviceKeyPair.publicKey),
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : 'device',
        ts: now,
        secretHashHex: hash(b4a.from(secretHex, 'hex')).toString('hex'),
        secretHex,
    }
    request.signature = sign(pairingSigningPayload(request), deviceKeyPair.secretKey).toString('hex')
    return request
}

export function verifyPairingRequest(request, offer, { now, windowMs = COMMAND_TS_WINDOW_MS } = {}) {
    if (!request || request.type !== 'pair' || Number(request.v) !== OWNER_CONTROL_VERSION) return refused('malformed')
    if (!offer || offer.used) return refused('pairing-used')
    if (!Number.isFinite(now) || now > offer.expiresAt) return refused('pairing-expired')
    if (!Number.isFinite(request.ts) || Math.abs(now - request.ts) > windowMs) return refused('expired')
    if (!isHex(request.deviceId, PUBLIC_KEY_BYTES) || !isHex(request.secretHex, SECRET_BYTES)) return refused('malformed')

    // Compare via hashes so the check is constant-time over attacker input.
    const secretHash = hash(b4a.from(request.secretHex, 'hex')).toString('hex')
    if (secretHash !== offer.secretHashHex || request.secretHashHex !== offer.secretHashHex) {
        return refused('pairing-secret-mismatch')
    }

    const verified = verify(
        pairingSigningPayload(request),
        b4a.from(String(request.signature ?? ''), 'hex'),
        b4a.from(request.deviceId, 'hex'),
    )
    if (!verified) return refused('bad-signature')

    return {
        ok: true,
        device: {
            deviceId: request.deviceId,
            name: request.name,
            capabilities: offer.capabilities,
        },
    }
}

// --- rotation -----------------------------------------------------------------

// A registered device replaces its own key: the rotate command's payload names
// the new public key and the envelope is signed by the old one.
export function createRotationPayload(newKeyPair) {
    return { newDeviceId: deviceIdFromPublicKey(newKeyPair.publicKey) }
}

export function applyRotation(registry, envelope, { now }) {
    const newDeviceId = normalizeHex(envelope?.payload?.newDeviceId, PUBLIC_KEY_BYTES)
    if (!newDeviceId) return refused('malformed-rotation')
    return registry.rotateDevice(envelope.deviceId, newDeviceId, now)
}

// --- client session ---------------------------------------------------------

// Transport-agnostic client glue: the app supplies `write(line)` (one JSON
// frame per line over its encrypted stream) and feeds incoming lines to
// `handleLine`. Sequence numbers start from the wall clock so they stay
// monotonic across client restarts without persisted state.
export function createOwnerControlSession({ keyPair: deviceKeyPair, write, now = () => Date.now(), seqStart }) {
    if (typeof write !== 'function') throw new Error('A write(line) transport is required')
    let seq = Number.isFinite(seqStart) && seqStart > 0 ? Math.floor(seqStart) : now()
    const pending = new Map()

    return {
        deviceId: deviceIdFromPublicKey(deviceKeyPair.publicKey),
        request(command, payload = null) {
            const envelope = createCommandEnvelope({
                keyPair: deviceKeyPair,
                command,
                payload,
                seq: ++seq,
                now: now(),
            })
            const response = new Promise((resolve) => pending.set(envelope.commandId, resolve))
            write(JSON.stringify(envelope))
            return response
        },
        pair(secretHex, name) {
            const request = createPairingRequest({ keyPair: deviceKeyPair, secretHex, name, now: now() })
            const response = new Promise((resolve) => pending.set(`pair:${request.deviceId}`, resolve))
            write(JSON.stringify(request))
            return response
        },
        handleLine(line) {
            let message = null
            try {
                message = JSON.parse(line)
            } catch {
                return false
            }
            const key = message?.type === 'pair-result' ? `pair:${message.deviceId}` : message?.commandId
            const resolve = key != null ? pending.get(key) : undefined
            if (!resolve) return false
            pending.delete(key)
            resolve(message)
            return true
        },
        pendingCount() {
            return pending.size
        },
    }
}

// --- helpers -------------------------------------------------------------------

export function normalizeCapabilities(capabilities) {
    if (!Array.isArray(capabilities)) return []
    return CAPABILITIES.filter((capability) => capabilities.includes(capability))
}

function refused(reason) {
    return { ok: false, reason }
}

function isHex(value, bytes) {
    return typeof value === 'string' && value.length === bytes * 2 && HEX.test(value)
}

function normalizeHex(value, bytes) {
    if (b4a.isBuffer(value) || value instanceof Uint8Array) {
        return value.byteLength === bytes ? b4a.toString(value, 'hex') : null
    }
    if (typeof value !== 'string') return null
    const hex = value.trim().toLowerCase()
    return isHex(hex, bytes) ? hex : null
}

function normalizeBuffer(value, bytes) {
    if (b4a.isBuffer(value) || value instanceof Uint8Array) {
        return value.byteLength === bytes ? b4a.from(value) : null
    }
    if (typeof value === 'string' && isHex(value.toLowerCase(), bytes)) {
        return b4a.from(value.toLowerCase(), 'hex')
    }
    return null
}
