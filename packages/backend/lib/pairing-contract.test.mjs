// The test that would have caught the original bug.
//
// For as long as this code has existed, every host-side refusal was
// `try { candidate.close() } catch (_) {}` at six separate sites. `close()` does
// not exist on blind-pairing-core's MemberRequest, so every refusal threw
// TypeError into an empty catch and did nothing: no reply was ever written, and
// the guest waited out its entire deadline with no idea whether the host had
// refused it, was unreachable, or had never existed.
//
// Nothing failed. Nothing logged. The methods this backend calls on third-party
// objects were never checked against the library, so the mistake was invisible
// for months and only surfaced as "sharing doesn't work on mobile data".
//
// These tests pin the external API surface the pairing code depends on. They are
// deliberately about EXISTENCE and SHAPE, not behaviour — a dependency bump that
// renames or drops one of these methods should break the suite loudly rather
// than degrade into silence at runtime.

import test from 'node:test'
import assert from 'node:assert/strict'
import BlindPairing from 'blind-pairing'
import { MemberRequest, CandidateRequest } from 'blind-pairing-core'

import { DENY_STATUS, JOIN_REASON, denyStatusForReason, joinFailureReason, refineTimeoutReason } from './pairing-tuning.mjs'

test('MemberRequest exposes the methods the host actually calls', () => {
    const proto = MemberRequest.prototype
    for (const method of ['open', 'confirm', 'deny', 'respond']) {
        assert.equal(typeof proto[method], 'function', `MemberRequest#${method} must exist`)
    }
})

test('MemberRequest has NO close() — the method six refusal sites used to call', () => {
    // If a future blind-pairing-core adds close(), this test failing is the
    // signal to re-read the refusal path, not to delete the assertion.
    assert.equal(
        MemberRequest.prototype.close,
        undefined,
        'refusals must go through deny(), which seals a reply the guest can decode',
    )
})

test('CandidateRequest emits rejection, which the guest must listen for', () => {
    // Host-side deny() is useless unless the guest is listening. The join used
    // to discard addCandidate()'s return value entirely, so this event had no
    // subscriber and a refusal was indistinguishable from silence.
    assert.equal(typeof CandidateRequest.prototype.handleResponse, 'function')
    assert.equal(typeof CandidateRequest.prototype.on, 'function', 'must be an EventEmitter')
})

test('BlindPairing accepts a poll override', () => {
    // The library default is seven minutes; the join deadline is two. Without an
    // override the NAT-free DHT mailbox — the only path that works on carrier
    // NAT — is read once, at t=0, before the host could have answered.
    const noopSwarm = { on () {}, once () {}, removeListener () {}, dht: { on () {} } }

    // The default is the thing that made the mailbox unreachable; assert it so a
    // future bump that changes it is visible here rather than in the field.
    assert.equal(new BlindPairing(noopSwarm).poll, 7 * 60 * 1000)
    assert.equal(new BlindPairing(noopSwarm, { poll: 15000 }).poll, 15000)
})

test('deny status codes match what a guest decodes', () => {
    // blind-pairing-core/index.js:106-118 maps these to PAIRING_REJECTED /
    // INVITE_USED / INVITE_EXPIRED. Drift here means the guest shows the wrong
    // reason, which is worse than showing none.
    assert.equal(DENY_STATUS.REJECTED, 1)
    assert.equal(DENY_STATUS.USED, 2)
    assert.equal(DENY_STATUS.EXPIRED, 3)

    assert.equal(denyStatusForReason('exhausted'), DENY_STATUS.USED)
    assert.equal(denyStatusForReason('expired'), DENY_STATUS.EXPIRED)
    assert.equal(denyStatusForReason('legacy'), DENY_STATUS.EXPIRED)
    assert.equal(denyStatusForReason('anything-else'), DENY_STATUS.REJECTED)

    // An unknown invite id means we hold no public key, so no reply can be
    // sealed at all. Null is the honest answer, not a status.
    assert.equal(denyStatusForReason('missing'), null)
})

test('joinFailureReason prefers the library error code over message matching', () => {
    assert.equal(joinFailureReason({ code: 'INVITE_USED' }), JOIN_REASON.INVITE_USED)
    assert.equal(joinFailureReason({ code: 'INVITE_EXPIRED' }), JOIN_REASON.INVITE_EXPIRED)
    assert.equal(joinFailureReason({ code: 'PAIRING_REJECTED' }), JOIN_REASON.REJECTED)

    assert.equal(joinFailureReason(new Error('Pairing timed out')), JOIN_REASON.TIMEOUT)
    assert.equal(joinFailureReason(new Error('Join cancelled')), JOIN_REASON.CANCELLED)
    assert.equal(joinFailureReason(new Error('Invite is empty or invalid')), JOIN_REASON.INVITE_INVALID)
    assert.equal(joinFailureReason(new Error('Pairing returned incomplete credentials')), JOIN_REASON.INCOMPLETE)
    assert.equal(joinFailureReason(new Error('something else entirely')), JOIN_REASON.UNKNOWN)
    assert.equal(joinFailureReason(null), JOIN_REASON.UNKNOWN)
})

test('a timeout is refined into no-network when the transport never came up', () => {
    // "We never reached the peer-to-peer network" and "we were on it but never
    // found the host" need different actions from the user, and were previously
    // the same two-minute spinner.
    assert.equal(
        refineTimeoutReason(JOIN_REASON.TIMEOUT, { online: false, connections: 0 }),
        JOIN_REASON.NO_NETWORK,
    )
    assert.equal(
        refineTimeoutReason(JOIN_REASON.TIMEOUT, { online: true, connections: 0 }),
        JOIN_REASON.TIMEOUT,
    )
    assert.equal(
        refineTimeoutReason(JOIN_REASON.TIMEOUT, { online: false, connections: 2 }),
        JOIN_REASON.TIMEOUT,
    )
    // Non-timeout reasons pass through untouched.
    assert.equal(refineTimeoutReason(JOIN_REASON.REJECTED, { online: false }), JOIN_REASON.REJECTED)
    assert.equal(refineTimeoutReason(JOIN_REASON.TIMEOUT, null), JOIN_REASON.TIMEOUT)
})
