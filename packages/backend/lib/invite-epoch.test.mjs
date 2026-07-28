import test from 'node:test'
import assert from 'node:assert/strict'
import BlindPairing from 'blind-pairing'
import {
    decodeInviteEpochData,
    encodeInviteEpochData,
    generateEpochKey,
} from './key-epochs.mjs'

// Regression for the cross-instance join bug: BlindPairing's confirm payload
// encodes only { key, encryptionKey, additional } — epoch material passed as
// extra confirm fields was silently dropped, so a real guest never received
// the list epoch key. The epoch key must ride in the invite's signed
// additional data instead.

test('invite epoch data round-trips through encode/decode', () => {
    const epochKey = generateEpochKey()
    const encoded = encodeInviteEpochData(epochKey, 3)

    const decoded = decodeInviteEpochData(encoded)
    assert.ok(decoded)
    assert.equal(decoded.epoch, 3)
    assert.equal(decoded.epochKey.toString('hex'), epochKey.toString('hex'))
})

test('invalid epoch data is rejected, never half-parsed', () => {
    assert.equal(encodeInviteEpochData(null, 1), null)
    assert.equal(encodeInviteEpochData(generateEpochKey(), 0), null)
    assert.equal(encodeInviteEpochData(Buffer.alloc(8), 1), null)

    assert.equal(decodeInviteEpochData(null), null)
    assert.equal(decodeInviteEpochData(Buffer.from('not json')), null)
    assert.equal(decodeInviteEpochData(Buffer.from(JSON.stringify({ version: 99, epochKey: 'aa', epoch: 1 }))), null)
    assert.equal(decodeInviteEpochData(Buffer.from(JSON.stringify({ version: 1, epochKey: 'aa', epoch: 1 }))), null)
    assert.equal(decodeInviteEpochData(Buffer.from(JSON.stringify({ version: 1, epochKey: 'a'.repeat(64), epoch: -2 }))), null)
})

test('BlindPairing invites carry the epoch payload as signed additional data', () => {
    const baseKey = Buffer.alloc(32, 7)
    const epochKey = generateEpochKey()
    const invite = BlindPairing.createInvite(baseKey, { data: encodeInviteEpochData(epochKey, 1) })

    // The host hands invite.additional to candidate.confirm; the joiner gets
    // it back (signature-verified) as paired.data.
    assert.ok(invite.additional?.data, 'invite mints additional data')
    assert.ok(invite.additional?.signature?.length > 0, 'additional data is signed')
    const decoded = decodeInviteEpochData(invite.additional.data)
    assert.equal(decoded.epochKey.toString('hex'), epochKey.toString('hex'))

    // The shareable invite blob itself must NOT leak the epoch key: only the
    // confirm reply (sent over the pairing-encrypted channel) carries it.
    assert.equal(invite.invite.includes(epochKey), false)
    assert.equal(
        invite.invite.toString('hex').includes(epochKey.toString('hex')),
        false,
        'epoch key must not be embedded in the shared invite code',
    )
})
