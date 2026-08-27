// Timings and failure vocabulary for the pairing handshake.
//
// The numbers here are not arbitrary — they encode a mismatch that made pairing
// impossible on mobile data and invisible everywhere.

// How often a blind-pairing participant re-reads the DHT mailbox.
//
// blind-pairing defaults to SEVEN MINUTES (DEFAULT_POLL, blind-pairing/index.js:14,
// randomised x1-1.5). Listam's join deadline is two minutes. Worse, a candidate's
// poll reads the reply slot *before* it announces itself
// (blind-pairing/index.js:651-668), so inside the old window a guest read the
// mailbox exactly once, at t=0, before the host could possibly have written to
// it — and then never again.
//
// That mailbox is the one path in the whole handshake that needs NO NAT
// traversal at all: the host writes the reply with mutablePut and the guest
// reads it with mutableGet, straight through the DHT. On carrier NAT, where
// holepunching is refused outright, it is the only path that can work. Polling
// it eight times inside the deadline instead of once is the single highest-value
// change in this remediation.
//
// 15s is a deliberate compromise: fast enough for ~8 reads inside the deadline,
// slow enough that an idle host with a live invite is not hammering the DHT.
export const PAIRING_POLL_MS = 15000

// Wall-clock budget for the blind-pairing step of a join.
export const JOIN_DEADLINE_MS = 120000

// When to start telling the user that slow is normal here rather than letting
// them stare at an unchanging spinner and conclude it is broken.
export const JOIN_SLOW_HINT_MS = 20000

// Cadence for the join-progress heartbeat. Every one of these is a log line and
// a UI update, so it has to be readable in a transcript, not a firehose.
export const JOIN_HEARTBEAT_MS = 10000

// blind-pairing-core's reply status codes (blind-pairing-core/index.js:106-118).
// A guest decodes these into PAIRING_REJECTED / INVITE_USED / INVITE_EXPIRED.
export const DENY_STATUS = {
    REJECTED: 1,
    USED: 2,
    EXPIRED: 3,
}

// Machine-readable reasons crossing the RPC boundary. The UI maps these to
// translated copy; previously it surfaced `Error.message` verbatim, so users saw
// untranslated English like "Pairing timed out" with no idea what to do.
export const JOIN_REASON = {
    TIMEOUT: 'timeout',
    INVITE_USED: 'invite-used',
    INVITE_EXPIRED: 'invite-expired',
    REJECTED: 'rejected',
    INVITE_INVALID: 'invite-invalid',
    NO_NETWORK: 'no-network',
    CANCELLED: 'cancelled',
    INCOMPLETE: 'incomplete-credentials',
    UNKNOWN: 'unknown',
}

/**
 * Map an invite-policy refusal reason onto the wire status a guest can decode.
 * `missing` has no status: an unknown invite id means we hold no public key for
 * it, and without that key a reply cannot even be sealed.
 *
 * @param {string} reason
 * @returns {number|null}
 */
export function denyStatusForReason(reason) {
    switch (reason) {
        case 'exhausted': return DENY_STATUS.USED
        case 'expired':
        case 'legacy': return DENY_STATUS.EXPIRED
        case 'missing': return null
        default: return DENY_STATUS.REJECTED
    }
}

/**
 * Classify a join failure into a stable reason code.
 *
 * blind-pairing-core throws PairingError with a `code`; everything else arrives
 * as an ordinary Error whose message is the only signal we have.
 *
 * @param {unknown} err
 * @returns {string} one of JOIN_REASON
 */
export function joinFailureReason(err) {
    const code = err && typeof err === 'object' ? err.code : null
    switch (code) {
        case 'INVITE_USED': return JOIN_REASON.INVITE_USED
        case 'INVITE_EXPIRED': return JOIN_REASON.INVITE_EXPIRED
        case 'PAIRING_REJECTED': return JOIN_REASON.REJECTED
        default: break
    }

    const message = err && typeof err === 'object' && typeof err.message === 'string'
        ? err.message
        : String(err ?? '')

    if (/cancelled|canceled/i.test(message)) return JOIN_REASON.CANCELLED
    if (/timed out|timeout/i.test(message)) return JOIN_REASON.TIMEOUT
    if (/empty or invalid|discovery key/i.test(message)) return JOIN_REASON.INVITE_INVALID
    if (/incomplete credentials|no epoch key/i.test(message)) return JOIN_REASON.INCOMPLETE
    return JOIN_REASON.UNKNOWN
}

/**
 * A timeout is the least informative outcome we can report, so refine it with
 * what the transport was actually doing. "We never reached the peer-to-peer
 * network" and "we were on the network but never found the host" are different
 * problems with different user actions, and they were indistinguishable.
 *
 * @param {string} reason
 * @param {{ bootstrapped?: boolean, online?: boolean, connections?: number }} net
 * @returns {string}
 */
export function refineTimeoutReason(reason, net) {
    if (reason !== JOIN_REASON.TIMEOUT) return reason
    if (!net) return reason
    const reachedNetwork = net.online === true || (net.connections ?? 0) > 0
    return reachedNetwork ? reason : JOIN_REASON.NO_NETWORK
}
