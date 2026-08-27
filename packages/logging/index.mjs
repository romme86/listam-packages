const LEVEL_PREFIX = /^\[(INFO|WARNING|WARN|ERROR|FATAL|AUDIT|DEBUG|TRACE)\]\s*/i
const HEX_KEY = /\b[0-9a-f]{64,}\b/gi
const Z32_BLOB = /\b[ybndrfg8ejkmcpqxot1uwisza345h769]{52,}\b/gi
const INVITE_PARAM = /([?&]invite=)[^&\s]+/gi
const CARD_PAYLOAD_ASSIGNMENT = /\b((?:barcode|barcodeData|qrData|cardData|loyaltyCardData|loyaltyCardPayload|rawScan|scanData)\s*[:=]\s*)[^\s,;}\]]+/gi
const SENSITIVE_KEYS = new Set([
    'key',
    'baseKey',
    'autobaseKey',
    'encryptionKey',
    'epochKey',
    'epochEncryptionKey',
    'epochKeyHash',
    'epochPublicKey',
    'encryptedEpochKey',
    'epochGrants',
    'ownerAuthorityKey',
    'ownerAuthorityPublicKey',
    'ownerAuthoritySecretKey',
    'ownerRecoveryCode',
    'recoveryCode',
    'recoverySeed',
    'encKey',
    'invite',
    'inviteKey',
    'publicKey',
    'privateKey',
    'writerKey',
    'writerKeyHex',
    'localWriterKey',
    'peerKey',
    'peerKeys',
    'topic',
    'topicId',
    'discoveryKey',
    'userData',
    'data',
    'value',
    'payload',
    'barcode',
    'barcodeData',
    'qrData',
    'cardData',
    'loyaltyCardData',
    'loyaltyCardPayload',
    'rawScan',
    'scanData',
    'authorization',
    'authHeader',
    'token',
    // Credentials. These were absent while the log buffer only ever went to a
    // terminal or journald; the field-diagnostics bundle (logTail) is meant to be
    // copied off the device and pasted into a chat, so an unredacted `password`
    // here is a credential in someone's message history.
    'password',
    'passwords',
    'currentPassword',
    'nextPassword',
    'newPassword',
    'passphrase',
    'secret',
    'secretKey',
    'credential',
    'credentials',
    'seed',
    'mnemonic'
].map((key) => key.toLowerCase()))

const ITEM_KEYS = ['text', 'isDone', 'timeOfCompletion']

export function redactForLog(value, depth = 0, seen = new WeakSet()) {
    if (value == null) return value
    if (depth > 4) return '[redacted-depth]'

    if (typeof value === 'string') return redactString(value)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function') return `[function:${value.name || 'anonymous'}]`

    if (value instanceof Error) {
        return {
            name: value.name,
            message: redactString(value.message || '')
        }
    }

    if (isBytes(value)) {
        return `[bytes:${value.byteLength}]`
    }

    if (Array.isArray(value)) {
        if (value.some(isListItemShape)) return `[items:${value.length}]`
        return value.map((entry) => redactForLog(entry, depth + 1, seen))
    }

    if (typeof value === 'object') {
        if (isListItemShape(value)) return '[item]'
        if (seen.has(value)) return '[circular]'
        seen.add(value)

        const out = {}
        for (const [key, entry] of Object.entries(value)) {
            if (SENSITIVE_KEYS.has(key.toLowerCase())) {
                out[key] = '[redacted]'
            } else {
                out[key] = redactForLog(entry, depth + 1, seen)
            }
        }
        return out
    }

    return '[redacted]'
}

export function redactString(value) {
    return String(value)
        .replace(INVITE_PARAM, '$1[redacted]')
        .replace(CARD_PAYLOAD_ASSIGNMENT, '$1[redacted-card]')
        .replace(HEX_KEY, '[redacted-hex]')
        .replace(Z32_BLOB, '[redacted-invite]')
}

export function redactForExport(value) {
    return redactForLog(value)
}

export function redactDiagnosticBundle(value) {
    return redactForLog(value)
}

export const DEFAULT_LOG_TAIL_CAPACITY = 500

// A ceiling as well as a default: the ring lives on a phone, so a caller asking
// for "everything" must still end up with a bounded buffer rather than a leak
// that only shows up as an OOM days into a long-running headless peer.
export const MAX_LOG_TAIL_CAPACITY = 10000

// One process-wide ring, not one per logger: a field diagnostic bundle has to be
// pullable with a single call, whichever logger instance happened to write the
// line. It matters most on mobile, where the backend singleton's only sink is the
// worklet's console — unreachable from the app, which is why the 2026-08-26
// pairing failure produced no evidence anyone could send us.
const tailState = {
    capacity: DEFAULT_LOG_TAIL_CAPACITY,
    lines: [],
    cursor: 0,
    dropped: 0
}

export function logTail(options = {}) {
    const lines = readTailLines()
    // A limit we cannot make sense of means "no limit": returning an empty bundle
    // because the caller passed null would hide the very evidence it asked for.
    const limit = clampCount(options.limit, lines.length)
    // Keep the newest lines: whatever wedged the device is at the end of the run.
    const entries = limit === null || limit >= lines.length
        ? lines
        : lines.slice(lines.length - limit)

    // The buffered lines were redacted on the way in, but this bundle is meant to
    // leave the device (screenshot, paste, support mail), so it pays a second pass.
    return redactDiagnosticBundle({
        entries,
        buffered: lines.length,
        dropped: tailState.dropped,
        capacity: tailState.capacity
    })
}

export function clearLogTail() {
    tailState.lines = []
    tailState.cursor = 0
    tailState.dropped = 0
    return tailStats()
}

export function configureLogTail(options = {}) {
    if (options.capacity !== undefined) {
        const capacity = clampCount(options.capacity, MAX_LOG_TAIL_CAPACITY)
        // Refuse rather than coerce: a garbage capacity used to clamp to 0, which
        // silently switched the field diagnostic off *and* threw away what was
        // already buffered. Failing at the call site is the whole point here.
        if (capacity === null) throw new TypeError('configureLogTail: capacity must be a finite number')
        const kept = readTailLines()
        const evicted = Math.max(0, kept.length - capacity)

        tailState.capacity = capacity
        tailState.lines = evicted ? kept.slice(evicted) : kept
        tailState.cursor = capacity ? tailState.lines.length % capacity : 0
        // Shrinking drops the oldest lines for real, so the bundle must own up to it.
        tailState.dropped += evicted
    }
    return tailStats()
}

export function parseLogArgs(args, options = {}) {
    let level = 'info'
    let message = ''
    const details = [...args]

    if (typeof details[0] === 'string') {
        message = details.shift()
        const match = message.match(LEVEL_PREFIX)
        if (match) {
            level = match[1].toLowerCase()
            if (level === 'warning') level = 'warn'
            message = message.replace(LEVEL_PREFIX, '')
        }
    }

    return {
        ts: new Date().toISOString(),
        level,
        app: options.app || 'backend',
        message: redactString(message),
        details: details.map((entry) => redactForLog(entry))
    }
}

export function formatLogLine(args, options = {}) {
    return JSON.stringify(parseLogArgs(args, options))
}

export function createLogger(options = {}) {
    const write = options.write || ((line) => console.error(line))
    const keepTail = options.tail !== false
    return {
        log(...args) {
            const line = formatLogLine(args, options)
            // Buffer before writing: a sink that throws is exactly the failure a
            // tail is there to explain.
            if (keepTail) pushTailLine(line)
            write(line)
        },
        info(message, ...details) {
            this.log(`[INFO] ${message}`, ...details)
        },
        warn(message, ...details) {
            this.log(`[WARNING] ${message}`, ...details)
        },
        error(message, ...details) {
            this.log(`[ERROR] ${message}`, ...details)
        }
    }
}

export const logger = createLogger({ app: 'backend' })

function pushTailLine(line) {
    if (tailState.capacity <= 0) {
        tailState.dropped += 1
        return
    }

    if (tailState.lines.length < tailState.capacity) {
        tailState.lines.push(line)
        tailState.cursor = tailState.lines.length % tailState.capacity
        return
    }

    // Full ring: the cursor slot holds the oldest line, so this write is exactly
    // one eviction.
    tailState.lines[tailState.cursor] = line
    tailState.cursor = (tailState.cursor + 1) % tailState.capacity
    tailState.dropped += 1
}

function readTailLines() {
    if (tailState.lines.length < tailState.capacity) return tailState.lines.slice()
    return tailState.lines.slice(tailState.cursor).concat(tailState.lines.slice(0, tailState.cursor))
}

function tailStats() {
    return {
        buffered: tailState.lines.length,
        dropped: tailState.dropped,
        capacity: tailState.capacity
    }
}

// Returns null for anything that is not a real number, so each caller decides what
// to do about it. No coercion: Number(null) and Number('') are both 0, and a 0 here
// means "buffer nothing" — the one outcome a bad argument must never produce
// silently. Infinity clamps to `max` rather than falling through to 0.
function clampCount(value, max) {
    if (typeof value !== 'number' || Number.isNaN(value)) return null
    const count = Math.floor(value)
    if (count < 0) return 0
    return Math.min(count, max)
}

function isBytes(value) {
    return typeof value?.byteLength === 'number' &&
        typeof value !== 'string' &&
        (value instanceof Uint8Array || value.constructor?.name === 'Buffer')
}

function isListItemShape(value) {
    return value &&
        typeof value === 'object' &&
        ITEM_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}
