import test from 'node:test'
import assert from 'node:assert/strict'
import BlindPairing from 'blind-pairing'
import { keyPair } from 'hypercore-crypto'
import {
    decodeInviteEpochData,
    encodeInviteEpochData,
    generateEpochKey,
} from './key-epochs.mjs'
import { createCompactionRecord, seedCompactionBarrier, snapshotDigestHex } from './compaction.mjs'

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

// ---------------------------------------------------------------------------
// The compaction barrier rides the same signed channel, for the same reason.
// ---------------------------------------------------------------------------
test('a compaction barrier survives the invite round trip and seeds a guest', () => {
    const owner = keyPair()
    const items = [{ id: 'a', listId: 'work', listType: 'todo', text: 'x', isDone: false, updatedAt: 1 }]
    const barrier = createCompactionRecord({
        ownerAuthorityKeyPair: owner,
        baseKey: 'ab'.repeat(32),
        sequence: 4,
        epoch: 7,
        snapshotDigest: snapshotDigestHex(items),
        clock: [{ writerKey: '11'.repeat(32), length: 900 }],
        createdAt: 1000,
    })

    const decoded = decodeInviteEpochData(encodeInviteEpochData(generateEpochKey(), 7, barrier))
    assert.deepEqual(decoded.barrier, barrier)

    // A guest can act on it immediately: honoured without having applied the
    // snapshot yet, because it cannot verify an owner signature before replaying
    // the very membership records the barrier lets it skip.
    const seeded = seedCompactionBarrier(decoded.barrier)
    assert.equal(seeded.honoured, true)
    assert.equal(seeded.sequence, 4)
    assert.equal(seeded.clock.get('11'.repeat(32)), 900)
})

test('an invite from a host with no barrier decodes to none, and the guest just replays', () => {
    // Rolling upgrade: an older host sends the epoch key alone. The absent
    // barrier must read as "no compaction", never as a malformed invite.
    const decoded = decodeInviteEpochData(encodeInviteEpochData(generateEpochKey(), 7))
    assert.equal(decoded.barrier, null)
    assert.equal(seedCompactionBarrier(decoded.barrier), null)
})

test('a malformed barrier in an invite is refused rather than silently suppressing history', () => {
    const decoded = decodeInviteEpochData(
        encodeInviteEpochData(generateEpochKey(), 7, { type: 'compaction', version: 1, sequence: 'nonsense' }),
    )
    assert.equal(seedCompactionBarrier(decoded.barrier), null)
})
