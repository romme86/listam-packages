// Relay selection for hyperswarm's `relayThrough`.
//
// Why this exists: on carrier-grade NAT — which is every 4G/5G connection —
// hyperdht samples its own NAT and finds a host but no consistent port, so
// `dht.randomized` is true (dht-rpc/index.js:134). From there:
//
//   * BOTH peers randomized  -> connect.js:652 aborts the connection with
//     HOLEPUNCH_DOUBLE_RANDOMIZED_NATS *without sending a single punch packet*.
//   * EITHER peer randomized -> connect.js:665 enters a rate-limited path whose
//     first statement is `if (!c.relayToken) throw HOLEPUNCH_ABORTED()`, and the
//     budget is one concurrent random punch per DHT with a 20s floor between
//     them (hyperdht/index.js:62), so a host already punching one guest kills
//     the next one instantly.
//
// A relay token only exists when `relayThrough` is configured
// (connect.js:96), so with no relay every phone-to-phone connection over mobile
// data fails before it starts. That is the 2026-08-26 field failure: three
// people on 4G, nobody past the first pairing step.
//
// Hyperswarm already knows how to recover — `shouldForceRelaying`
// (hyperswarm/index.js:670) matches exactly HOLEPUNCH_ABORTED,
// HOLEPUNCH_DOUBLE_RANDOMIZED_NATS and REMOTE_NOT_HOLEPUNCHABLE, then sets
// `forceRelaying` and resets the backoff. That whole block is dead code until
// `relayThrough` is non-null. This module is what makes it live.
//
// One `relayThrough` on the Hyperswarm covers both directions: hyperswarm hands
// it to `dht.createServer` (index.js:50) and to `dht.connect` (index.js:210),
// so the accepting host and the dialing guest are both covered.

import z32 from 'z32'
import b4a from 'b4a'

// Relays operated for Listam. A relay only ever sees encrypted UDX frames it
// cannot read — blind-relay pairs two streams by a preexchanged token and
// forwards bytes — so this is a reachability aid, not a trust boundary. It is
// still a liveness dependency, which is why the list is plural: `selectRelay`
// picks one at random per connection (hyperdht/lib/connect.js:876).
export const DEFAULT_RELAY_KEYS = [
    // Geekom (cassandrina-app), deployed 2026-08-27. Derived from a seed
    // persisted at ~/listam-relay, so it survives restarts and reinstalls —
    // rotating it would strand every client already shipping this constant.
    '8kn1epgsuok4zbkq3odaz7xf67yrs81bt7g1ztnr5fdq6aahfj1o',
]

const RELAY_KEY_BYTES = 32

/**
 * Decode one relay public key. Accepts z32 (how the relay prints itself and how
 * hyperdht keys travel everywhere else in Listam) or hex, and rejects anything
 * that is not exactly a 32-byte key rather than letting a typo silently become
 * an unreachable relay.
 *
 * @param {string|Uint8Array} value
 * @returns {Buffer|null}
 */
export function parseRelayKey(value) {
    if (b4a.isBuffer(value) || value instanceof Uint8Array) {
        return value.byteLength === RELAY_KEY_BYTES ? b4a.from(value) : null
    }
    if (typeof value !== 'string') return null

    const trimmed = value.trim()
    if (!trimmed) return null

    if (/^[0-9a-f]{64}$/i.test(trimmed)) return b4a.from(trimmed, 'hex')

    try {
        const decoded = z32.decode(trimmed)
        return decoded.byteLength === RELAY_KEY_BYTES ? b4a.from(decoded) : null
    } catch {
        return null
    }
}

/**
 * Normalize a relay configuration into keys. Accepts an array or a
 * comma/whitespace separated string so the same value can come from a config
 * file, an env var, or a platform adapter. Unparseable entries are dropped and
 * reported rather than throwing: a bad relay key must never stop the app from
 * booting, it just costs relaying.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {{ keys: Buffer[], rejected: string[] }}
 */
export function parseRelayKeys(value) {
    if (value === null || value === undefined || value === '') return { keys: [], rejected: [] }

    const raw = Array.isArray(value) ? value : String(value).split(/[\s,]+/)
    const keys = []
    const rejected = []
    const seen = new Set()

    for (const entry of raw) {
        if (entry === null || entry === undefined || entry === '') continue
        const key = parseRelayKey(entry)
        if (!key) {
            rejected.push(typeof entry === 'string' ? entry : '<non-string>')
            continue
        }
        const fingerprint = b4a.toString(key, 'hex')
        if (seen.has(fingerprint)) continue
        seen.add(fingerprint)
        keys.push(key)
    }

    return { keys, rejected }
}

/**
 * Build the `relayThrough` option for Hyperswarm.
 *
 * The gating mirrors hyperswarm's own `toRelayFunction` (index.js:686): relay
 * when this device's NAT is randomized (nothing else will work), or when
 * hyperswarm forces it after a holepunch abort. It deliberately does NOT relay
 * unconditionally — on a normal home or office network a direct punch is faster
 * and costs the relay nothing.
 *
 * Both call sites reach us with the swarm: hyperswarm's `_maybeRelayConnection`
 * (index.js:107) forwards `(force, this)` on the client path, and the server
 * path resolves the same bound method through `selectRelay` with no arguments,
 * which still lands in `_maybeRelayConnection` and forwards the swarm. Treat a
 * missing swarm as "not randomized" rather than assuming either way.
 *
 * @param {Buffer[]} keys
 * @param {{ onEngage?: (info: { forced: boolean, randomized: boolean }) => void }} [opts]
 * @returns {((force: boolean, swarm: any) => Buffer|null)|null} null when no relay is configured,
 *   which leaves Hyperswarm exactly as it behaved before this module existed.
 */
export function createRelayThrough(keys, { onEngage = null } = {}) {
    if (!Array.isArray(keys) || keys.length === 0) return null

    // Relaying engaging at all is the interesting transition — it means this
    // device cannot punch directly. Logged once per swarm instead of per
    // connection, which would be unreadable on a busy peer.
    let engaged = false

    return (force, swarmRef) => {
        const randomized = swarmRef?.dht?.randomized === true
        const forced = force === true
        if (!forced && !randomized) return null

        if (!engaged) {
            engaged = true
            if (onEngage) {
                try { onEngage({ forced, randomized }) } catch { /* logging must never break connect */ }
            }
        }

        return keys.length === 1
            ? keys[0]
            : keys[Math.floor(Math.random() * keys.length)]
    }
}

/**
 * Short, non-secret identifiers for logs and diagnostics. Relay public keys are
 * not secret, but full keys make log lines unreadable and invite copy-paste
 * confusion with base keys.
 *
 * @param {Buffer[]} keys
 * @returns {string[]}
 */
export function relayFingerprints(keys) {
    if (!Array.isArray(keys)) return []
    return keys.map((key) => b4a.toString(key, 'hex').slice(0, 8))
}

// --- Process-wide relay registry --------------------------------------------
//
// Held here rather than in network.mjs so shared-base.mjs can read it too
// without importing network.mjs (which would close an import cycle through
// backend.mjs). Every Hyperswarm in the backend — including the short-lived
// pairing swarms — must be built with these options: a peer that relays its
// data connections but not its pairing connection still cannot pair on mobile
// data, which is the case that started this.

let configuredRelayKeys = []

/**
 * @param {string|string[]|null|undefined} value
 * @returns {{ keys: Buffer[], rejected: string[] }}
 */
export function setRelayKeys(value) {
    const parsed = parseRelayKeys(value)
    configuredRelayKeys = parsed.keys
    return parsed
}

export function getRelayKeys() {
    return configuredRelayKeys
}

/**
 * Build Hyperswarm options carrying both the (optional) private-DHT bootstrap
 * and the relay configuration.
 *
 * @param {any[]|null} bootstrap
 * @param {{ onEngage?: (info: any) => void }} [opts]
 */
export function relaySwarmOptions(bootstrap, { onEngage = null } = {}) {
    const options = bootstrap && bootstrap.length ? { bootstrap } : {}
    const relayThrough = createRelayThrough(configuredRelayKeys, { onEngage })
    if (relayThrough) options.relayThrough = relayThrough
    return options
}
