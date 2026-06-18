// @listam/provisioning — the wire contract for initializing a listam "leaf"
// (ESP32-S3 voice node) over Bluetooth Low Energy.
//
// The leaf is a BLE PERIPHERAL exposing a tiny custom GATT service: one
// config-write characteristic (the central streams a framed config blob into
// it) and one status-notify characteristic (the leaf reports progress/result).
// Three apps act as the CENTRAL — headless (noble), desktop (Web Bluetooth),
// mobile (react-native-ble-plx) — and all share this single module for the
// UUIDs, payload schema, framing and orchestration. The BLE transport itself
// is per-runtime and INJECTED (see `provisionLeaf`), so this core file imports
// nothing and loads identically in Node, Bare and React Native.
//
// Trust model (v1): the payload travels in cleartext and trust is anchored on
// physical BLE proximity. The `v` version field is reserved so a future
// PIN/AEAD-wrapped payload is a non-breaking upgrade.

// --- GATT identifiers --------------------------------------------------------
// Custom 128-bit UUIDs. The first 12 hex nibbles spell "listam-LEAF" in ASCII
// (6c697374 = "list", 616d = "am", 4c45 = "LE", 4146 = "AF"); the trailing
// byte distinguishes the service (01) and its two characteristics (02/03).
export const SERVICE_UUID = '6c697374-616d-4c45-4146-000000000001'
export const CHAR_CONFIG_UUID = '6c697374-616d-4c45-4146-000000000002'
export const CHAR_STATUS_UUID = '6c697374-616d-4c45-4146-000000000003'

// The leaf advertises under this name + a MAC-derived suffix, e.g.
// "listam-leaf-3F7A". Centrals may scan by service UUID and/or this prefix.
export const ADVERTISED_NAME_PREFIX = 'listam-leaf'

export const PROVISIONING_PAYLOAD_VERSION = 1

// Max wifi networks the leaf firmware roams across (main.rs Config: ssid/ssid2/ssid3).
export const MAX_WIFI_NETWORKS = 3

// --- Framing -----------------------------------------------------------------
// BLE characteristic writes are MTU-bounded, so the config blob is sent as a
// short sequence of frames the firmware reassembles. Every frame's first byte
// is an opcode:
//   BEGIN  [0x01, lenLo, lenHi]                 reset buffer, expect `len` bytes
//   CHUNK  [0x02, offLo, offHi, ...payload]     copy payload bytes at `off`
//   COMMIT [0x03, crcLo, crcHi]                 end; verify total + CRC16, apply
// Offsets make the stream idempotent/reorder-tolerant; the COMMIT CRC16 guards
// against silent corruption. The firmware's C reassembler mirrors this exactly.
export const FRAME_BEGIN = 0x01
export const FRAME_CHUNK = 0x02
export const FRAME_COMMIT = 0x03

// Safe default usable characteristic-value size: the BLE 4.0 ATT default MTU is
// 23 bytes, minus the 3-byte ATT write header. Centrals that negotiate a larger
// MTU should pass it so fewer, larger chunks are sent.
export const DEFAULT_MTU = 20

// Status codes the leaf reports over the notify characteristic.
export const STATUS = Object.freeze({
    IDLE: 0,
    RECEIVING: 1,
    APPLYING: 2,
    OK: 3,
    ERR_CRC: 4,
    ERR_DECODE: 5,
    ERR_VALIDATE: 6,
    ERR_NVS: 7,
})

const STATUS_NAME = Object.freeze(
    Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k])),
)

export function statusName(code) {
    return STATUS_NAME[code] ?? `UNKNOWN(${code})`
}

export function isTerminalStatus(code) {
    return code >= STATUS.OK
}

export function isErrorStatus(code) {
    return code > STATUS.OK
}

// --- helpers (no external deps) ----------------------------------------------
// `@listam/secrets` keeps its hex helpers private, so we re-implement the one
// guard we need rather than reaching into its internals.
export function isHex32(value) {
    return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)
}

const HAS_TEXT_CODECS = typeof TextEncoder !== 'undefined' && typeof TextDecoder !== 'undefined'

function utf8Encode(str) {
    if (HAS_TEXT_CODECS) return new TextEncoder().encode(str)
    throw new Error('TextEncoder is unavailable in this runtime')
}

function utf8Decode(bytes) {
    if (HAS_TEXT_CODECS) return new TextDecoder().decode(bytes)
    throw new Error('TextDecoder is unavailable in this runtime')
}

// CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF). Matches the firmware shim.
export function crc16(bytes) {
    let crc = 0xffff
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i] << 8
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
        }
    }
    return crc & 0xffff
}

// --- payload -----------------------------------------------------------------
// Build a normalized provisioning payload object. Mirrors the leaf firmware
// Config (main.rs:29-63): up to 3 wifi networks, the hub address list, the
// 64-hex control key, and optional voice params.
export function buildProvisioningPayload({
    controlKey,
    hubAddr,
    wifi = [],
    audioAddr,
    wakeDbThreshold,
    ledGpio,
} = {}) {
    const payload = {
        v: PROVISIONING_PAYLOAD_VERSION,
        control_key: typeof controlKey === 'string' ? controlKey.trim().toLowerCase() : controlKey,
        hub_addr: typeof hubAddr === 'string' ? hubAddr.trim() : hubAddr,
        wifi: (Array.isArray(wifi) ? wifi : [])
            .slice(0, MAX_WIFI_NETWORKS)
            .map((n) => ({ ssid: n?.ssid ?? '', psk: n?.psk ?? '' })),
    }
    if (audioAddr != null && audioAddr !== '') payload.audio_addr = String(audioAddr).trim()
    if (Number.isInteger(wakeDbThreshold)) payload.wake_db_threshold = wakeDbThreshold
    if (Number.isInteger(ledGpio)) payload.led_gpio = ledGpio
    return payload
}

// Throw if the payload could not initialize a leaf. Returns the payload.
export function validateProvisioningPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('provisioning payload must be an object')
    }
    if (payload.v !== PROVISIONING_PAYLOAD_VERSION) {
        throw new Error(`unsupported provisioning payload version: ${payload.v}`)
    }
    if (!isHex32(payload.control_key)) {
        throw new Error('control_key must be 64 hex characters')
    }
    if (typeof payload.hub_addr !== 'string' || payload.hub_addr.trim() === '') {
        throw new Error('hub_addr is required')
    }
    if (!Array.isArray(payload.wifi) || payload.wifi.length === 0) {
        throw new Error('at least one wifi network is required')
    }
    if (payload.wifi.length > MAX_WIFI_NETWORKS) {
        throw new Error(`at most ${MAX_WIFI_NETWORKS} wifi networks are supported`)
    }
    for (const net of payload.wifi) {
        if (!net || typeof net.ssid !== 'string' || net.ssid === '') {
            throw new Error('each wifi network needs a non-empty ssid')
        }
        if (net.psk != null && typeof net.psk !== 'string') {
            throw new Error('wifi psk must be a string')
        }
    }
    if (payload.wake_db_threshold != null && !Number.isInteger(payload.wake_db_threshold)) {
        throw new Error('wake_db_threshold must be an integer')
    }
    return payload
}

// Encode a (validated) payload to the raw JSON bytes streamed over BLE.
export function encodePayload(payload) {
    validateProvisioningPayload(payload)
    return utf8Encode(JSON.stringify(payload))
}

// Decode raw JSON bytes back to a validated payload (round-trip / tests).
export function decodePayload(bytes) {
    const payload = JSON.parse(utf8Decode(bytes))
    return validateProvisioningPayload(payload)
}

// --- chunking ----------------------------------------------------------------
// Split raw payload bytes into BEGIN/CHUNK*/COMMIT frames, each no larger than
// `mtu` usable bytes. Returns an array of Uint8Array frames to write in order.
export function chunkPayload(bytes, mtu = DEFAULT_MTU) {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
    if (!Number.isInteger(mtu) || mtu < 4) {
        throw new Error('mtu must be an integer >= 4')
    }
    if (data.length > 0xffff) {
        throw new Error('payload too large to frame (> 65535 bytes)')
    }
    const frames = []
    const begin = new Uint8Array(3)
    begin[0] = FRAME_BEGIN
    begin[1] = data.length & 0xff
    begin[2] = (data.length >> 8) & 0xff
    frames.push(begin)

    const maxData = mtu - 3 // opcode + 2 offset bytes
    for (let off = 0; off < data.length; off += maxData) {
        const slice = data.subarray(off, Math.min(off + maxData, data.length))
        const frame = new Uint8Array(3 + slice.length)
        frame[0] = FRAME_CHUNK
        frame[1] = off & 0xff
        frame[2] = (off >> 8) & 0xff
        frame.set(slice, 3)
        frames.push(frame)
    }

    const crc = crc16(data)
    const commit = new Uint8Array(3)
    commit[0] = FRAME_COMMIT
    commit[1] = crc & 0xff
    commit[2] = (crc >> 8) & 0xff
    frames.push(commit)
    return frames
}

// Reference reassembler mirroring the firmware C shim — used in tests to prove
// chunk -> reassemble is lossless and the CRC check holds.
export function reassemble(frames) {
    let buf = null
    let received = 0
    for (const frame of frames) {
        const op = frame[0]
        if (op === FRAME_BEGIN) {
            const len = frame[1] | (frame[2] << 8)
            buf = new Uint8Array(len)
            received = 0
        } else if (op === FRAME_CHUNK) {
            if (!buf) return { ok: false, error: 'chunk before begin' }
            const off = frame[1] | (frame[2] << 8)
            const slice = frame.subarray(3)
            buf.set(slice, off)
            received += slice.length
        } else if (op === FRAME_COMMIT) {
            if (!buf) return { ok: false, error: 'commit before begin' }
            if (received !== buf.length) return { ok: false, error: 'incomplete payload' }
            const want = frame[1] | (frame[2] << 8)
            if (crc16(buf) !== want) return { ok: false, error: 'crc mismatch' }
            return { ok: true, payload: buf }
        } else {
            return { ok: false, error: `unknown frame opcode ${op}` }
        }
    }
    return { ok: false, error: 'no commit frame' }
}

// --- orchestration -----------------------------------------------------------
// Drive a single provisioning session over an already-connected transport.
//
// `transport` is the injected, runtime-specific BLE adapter — the only contract
// this core needs from it:
//   write(charUuid, bytes): Promise<void>          // write to the config char
//   subscribe(charUuid, onValue): Promise<unsubscribe|void>  // status notifies
//   mtu?: number                                   // usable value bytes, optional
//
// Resolves { ok: true } when the leaf reports STATUS.OK (it then reboots into
// the provisioned path), rejects on any error status or timeout.
export async function provisionLeaf({ transport, payload, mtu, onStatus, timeoutMs = 30000 } = {}) {
    if (!transport || typeof transport.write !== 'function' || typeof transport.subscribe !== 'function') {
        throw new Error('transport must provide write() and subscribe()')
    }
    const bytes = encodePayload(payload)
    const frames = chunkPayload(bytes, mtu ?? transport.mtu ?? DEFAULT_MTU)

    let settle
    const done = new Promise((resolve, reject) => {
        settle = { resolve, reject }
    })

    let timer = null
    let unsubscribe = null
    const cleanup = async () => {
        if (timer) clearTimeout(timer)
        if (typeof unsubscribe === 'function') {
            try {
                await unsubscribe()
            } catch {
                // best-effort; the link may already be gone after a successful reboot
            }
        }
    }

    const handleStatus = (value) => {
        const code = value && value.length ? value[0] : value
        onStatus?.(code, statusName(code))
        if (code === STATUS.OK) settle.resolve({ ok: true })
        else if (isErrorStatus(code)) settle.reject(new Error(`leaf reported ${statusName(code)}`))
    }

    unsubscribe = await transport.subscribe(CHAR_STATUS_UUID, handleStatus)
    timer = setTimeout(() => settle.reject(new Error('provisioning timed out')), timeoutMs)

    try {
        for (const frame of frames) {
            await transport.write(CHAR_CONFIG_UUID, frame)
        }
        const result = await done
        return result
    } finally {
        await cleanup()
    }
}
