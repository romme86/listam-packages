import test from 'node:test'
import assert from 'node:assert/strict'
import {
    ADD_WRITER_ACTION,
    buildMembershipRoster,
    createAddWriterMembershipRecord,
    createMembershipState,
    createOwnerAuthorityKeyPair,
    createOwnerBootstrapRecord,
    createRemoveWriterMembershipRecord,
    nextMembershipSequence,
    ownerAuthorityPublicKeyHex,
    reduceMembershipLog,
    reduceMembershipOperation,
} from './membership.mjs'
import {
    createEpochEncryptionKeyPair,
    createEpochGrants,
    epochKeyHashHex,
    epochPublicKeyHex,
    generateEpochKey,
} from './key-epochs.mjs'

const baseKey = Buffer.from('a'.repeat(64), 'hex')
const ownerWriterKey = Buffer.from('b'.repeat(64), 'hex')
const guestWriterKey = Buffer.from('c'.repeat(64), 'hex')

test('owner bootstrap migrates a legacy single-user base once', () => {
    const owner = createOwnerAuthorityKeyPair()
    const bootstrap = createOwnerBootstrapRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: ownerWriterKey,
        baseKey,
        createdAt: 1000,
    })

    const result = reduceMembershipOperation(bootstrap, createMembershipState(), { baseKey })

    assert.equal(result.ok, true)
    assert.equal(result.state.ownerAuthorityKey, ownerAuthorityPublicKeyHex(owner))
    assert.equal(result.state.highestSequence, 1)
    assert.equal(result.state.writers.has(ownerWriterKey.toString('hex')), true)

    const second = reduceMembershipOperation(bootstrap, result.state, { baseKey })
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'owner-exists')
})

test('owner-signed add-writer records produce a writer-add effect', () => {
    const owner = createOwnerAuthorityKeyPair()
    const bootstrap = createOwnerBootstrapRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: ownerWriterKey,
        baseKey,
        createdAt: 1000,
    })
    const bootstrapped = reduceMembershipOperation(bootstrap, createMembershipState(), { baseKey }).state
    const addWriter = createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guestWriterKey,
        baseKey,
        sequence: nextMembershipSequence(bootstrapped),
        createdAt: 2000,
    })

    const result = reduceMembershipOperation(addWriter, bootstrapped, { baseKey })

    assert.equal(result.ok, true)
    assert.deepEqual(result.effect, { addWriterKey: guestWriterKey.toString('hex') })
    assert.equal(result.state.highestSequence, 2)
    assert.equal(result.state.writers.has(guestWriterKey.toString('hex')), true)
})

test('non-owner and cross-base membership additions are rejected', () => {
    const owner = createOwnerAuthorityKeyPair()
    const nonOwner = createOwnerAuthorityKeyPair()
    const bootstrap = createOwnerBootstrapRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: ownerWriterKey,
        baseKey,
        createdAt: 1000,
    })
    const state = reduceMembershipOperation(bootstrap, createMembershipState(), { baseKey }).state

    const nonOwnerAdd = createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: nonOwner,
        writerKey: guestWriterKey,
        baseKey,
        sequence: nextMembershipSequence(state),
        createdAt: 2000,
    })
    assert.equal(reduceMembershipOperation(nonOwnerAdd, state, { baseKey }).reason, 'wrong-owner')

    const wrongBaseAdd = createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guestWriterKey,
        baseKey: Buffer.from('d'.repeat(64), 'hex'),
        sequence: nextMembershipSequence(state),
        createdAt: 2000,
    })
    assert.equal(reduceMembershipOperation(wrongBaseAdd, state, { baseKey }).reason, 'wrong-base')
})

test('malformed, unsigned, tampered, and replayed membership ops are rejected', () => {
    const owner = createOwnerAuthorityKeyPair()
    const bootstrap = createOwnerBootstrapRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: ownerWriterKey,
        baseKey,
        createdAt: 1000,
    })
    const state = reduceMembershipOperation(bootstrap, createMembershipState(), { baseKey }).state

    assert.equal(reduceMembershipOperation({ type: 'membership' }, state, { baseKey }).reason, 'malformed')

    const unsigned = {
        type: 'membership',
        version: 1,
        action: ADD_WRITER_ACTION,
        baseKey: baseKey.toString('hex'),
        ownerAuthorityKey: ownerAuthorityPublicKeyHex(owner),
        writerKey: guestWriterKey.toString('hex'),
        sequence: 2,
        createdAt: 2000,
    }
    assert.equal(reduceMembershipOperation(unsigned, state, { baseKey }).reason, 'unsigned')

    const signed = createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guestWriterKey,
        baseKey,
        sequence: 2,
        createdAt: 2000,
    })
    const tampered = { ...signed, writerKey: Buffer.from('e'.repeat(64), 'hex').toString('hex') }
    assert.equal(reduceMembershipOperation(tampered, state, { baseKey }).reason, 'bad-signature')

    const accepted = reduceMembershipOperation(signed, state, { baseKey })
    assert.equal(accepted.ok, true)
    assert.equal(reduceMembershipOperation(signed, accepted.state, { baseKey }).reason, 'replay')
})

test('rejected membership ops carry no writer-add effect (apply adds no writer)', () => {
    const owner = createOwnerAuthorityKeyPair()
    const impostor = createOwnerAuthorityKeyPair()
    const state = reduceMembershipOperation(
        createOwnerBootstrapRecord({ ownerAuthorityKeyPair: owner, writerKey: ownerWriterKey, baseKey, createdAt: 1000 }),
        createMembershipState(),
        { baseKey },
    ).state

    // A non-owner signs its own add-writer; apply() keys host.addWriter off
    // result.effect.addWriterKey, so a null effect means no writer is added.
    const forged = createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: impostor,
        writerKey: guestWriterKey,
        baseKey,
        sequence: nextMembershipSequence(state),
        createdAt: 2000,
    })
    const result = reduceMembershipOperation(forged, state, { baseKey })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'wrong-owner')
    assert.equal(result.effect, null)
})

test('membership state is rebuilt from the persisted log after a restart', () => {
    const owner = createOwnerAuthorityKeyPair()
    const guest1 = Buffer.from('c'.repeat(64), 'hex')
    const guest2 = Buffer.from('d'.repeat(64), 'hex')

    // Build the log the way live apply() does: each new record uses the next
    // sequence from the running state.
    const log = [createOwnerBootstrapRecord({ ownerAuthorityKeyPair: owner, writerKey: ownerWriterKey, baseKey, createdAt: 1000 })]
    log.push(createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guest1,
        baseKey,
        sequence: nextMembershipSequence(reduceMembershipLog(log, { baseKey })),
        createdAt: 2000,
    }))
    log.push(createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guest2,
        baseKey,
        sequence: nextMembershipSequence(reduceMembershipLog(log, { baseKey })),
        createdAt: 3000,
    }))

    // Restart: state is reconstructed purely from the persisted records.
    const rebuilt = reduceMembershipLog(log, { baseKey })
    assert.equal(rebuilt.ownerAuthorityKey, ownerAuthorityPublicKeyHex(owner))
    assert.equal(rebuilt.highestSequence, 3)
    assert.equal(rebuilt.writers.has(ownerWriterKey.toString('hex')), true)
    assert.equal(rebuilt.writers.has(guest1.toString('hex')), true)
    assert.equal(rebuilt.writers.has(guest2.toString('hex')), true)

    // The next writer added after the restart must continue the sequence (4),
    // not reuse 2 — otherwise a fresh peer rejects it as a replay.
    const nextSeq = nextMembershipSequence(rebuilt)
    assert.equal(nextSeq, 4)
    const guest3 = Buffer.from('e'.repeat(64), 'hex')
    log.push(createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guest3,
        baseKey,
        sequence: nextSeq,
        createdAt: 4000,
    }))

    const fresh = reduceMembershipLog(log, { baseKey })
    assert.equal(fresh.highestSequence, 4)
    assert.equal(fresh.writers.has(guest3.toString('hex')), true)
})

test('a writer minted with a reused sequence is rejected on full replay', () => {
    const owner = createOwnerAuthorityKeyPair()
    const log = [
        createOwnerBootstrapRecord({ ownerAuthorityKeyPair: owner, writerKey: ownerWriterKey, baseKey, createdAt: 1000 }),
        createAddWriterMembershipRecord({ ownerAuthorityKeyPair: owner, writerKey: guestWriterKey, baseKey, sequence: 2, createdAt: 2000 }),
    ]

    // This is what a lost-membership-state restart used to mint: a new writer
    // re-using sequence 2. A fresh peer replaying the whole log must drop it.
    const reusedSeqKey = Buffer.from('f'.repeat(64), 'hex')
    const collision = createAddWriterMembershipRecord({ ownerAuthorityKeyPair: owner, writerKey: reusedSeqKey, baseKey, sequence: 2, createdAt: 3000 })

    const afterCollision = reduceMembershipLog([...log, collision], { baseKey })
    assert.equal(afterCollision.highestSequence, 2)
    assert.equal(afterCollision.writers.has(reusedSeqKey.toString('hex')), false)
})

test('duplicate owner bootstrap records are ignored on replay', () => {
    const owner = createOwnerAuthorityKeyPair()
    const bootstrap = createOwnerBootstrapRecord({ ownerAuthorityKeyPair: owner, writerKey: ownerWriterKey, baseKey, createdAt: 1000 })

    const rebuilt = reduceMembershipLog([bootstrap, bootstrap], { baseKey })
    assert.equal(rebuilt.ownerAuthorityKey, ownerAuthorityPublicKeyHex(owner))
    assert.equal(rebuilt.highestSequence, 1)
    assert.equal(rebuilt.writers.size, 1)
})

test('owner-signed member removal rotates epoch and prevents removed writer re-add', () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const epoch2 = generateEpochKey()

    const bootstrap = createOwnerBootstrapRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: ownerWriterKey,
        baseKey,
        epochPublicKey: epochPublicKeyHex(ownerEpoch),
        epochKey: epoch1,
        createdAt: 1000,
    })
    const addGuest = createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guestWriterKey,
        baseKey,
        sequence: 2,
        epochPublicKey: epochPublicKeyHex(guestEpoch),
        createdAt: 2000,
    })
    const active = reduceMembershipLog([bootstrap, addGuest], { baseKey })
    const grants = createEpochGrants({
        epochKey: epoch2,
        recipients: [{
            writerKey: ownerWriterKey,
            epochPublicKey: epochPublicKeyHex(ownerEpoch),
        }],
    })
    const removeGuest = createRemoveWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guestWriterKey,
        baseKey,
        sequence: nextMembershipSequence(active),
        previousEpoch: active.currentEpoch,
        epoch: active.currentEpoch + 1,
        epochKey: epoch2,
        epochGrants: grants,
        createdAt: 3000,
    })

    const removed = reduceMembershipOperation(removeGuest, active, { baseKey })
    assert.equal(removed.ok, true)
    assert.equal(removed.state.currentEpoch, 2)
    assert.equal(removed.state.currentEpochKeyHash, epochKeyHashHex(epoch2))
    assert.equal(removed.state.writers.has(guestWriterKey.toString('hex')), false)
    assert.deepEqual(removed.effect.audit, {
        type: 'member-removed',
        writerKey: guestWriterKey.toString('hex'),
        epoch: 2,
        createdAt: 3000,
    })

    const readdRemovedWriter = createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guestWriterKey,
        baseKey,
        sequence: nextMembershipSequence(removed.state),
        epochPublicKey: epochPublicKeyHex(guestEpoch),
        createdAt: 4000,
    })
    assert.equal(reduceMembershipOperation(readdRemovedWriter, removed.state, { baseKey }).reason, 'removed-writer')
})

test('member-removal records reject stale epochs, missing grants, and replay', () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const epoch2 = generateEpochKey()
    const active = reduceMembershipLog([
        createOwnerBootstrapRecord({
            ownerAuthorityKeyPair: owner,
            writerKey: ownerWriterKey,
            baseKey,
            epochPublicKey: epochPublicKeyHex(ownerEpoch),
            epochKey: epoch1,
            createdAt: 1000,
        }),
        createAddWriterMembershipRecord({
            ownerAuthorityKeyPair: owner,
            writerKey: guestWriterKey,
            baseKey,
            sequence: 2,
            epochPublicKey: epochPublicKeyHex(guestEpoch),
            createdAt: 2000,
        }),
    ], { baseKey })
    const grants = createEpochGrants({
        epochKey: epoch2,
        recipients: [{
            writerKey: ownerWriterKey,
            epochPublicKey: epochPublicKeyHex(ownerEpoch),
        }],
    })

    const valid = createRemoveWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guestWriterKey,
        baseKey,
        sequence: 3,
        previousEpoch: 1,
        epoch: 2,
        epochKey: epoch2,
        epochGrants: grants,
        createdAt: 3000,
    })
    assert.equal(reduceMembershipOperation(valid, active, { baseKey }).ok, true)
    assert.equal(reduceMembershipOperation(valid, reduceMembershipOperation(valid, active, { baseKey }).state, { baseKey }).reason, 'replay')

    const staleEpoch = createRemoveWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guestWriterKey,
        baseKey,
        sequence: 3,
        previousEpoch: 2,
        epoch: 3,
        epochKey: epoch2,
        epochGrants: grants,
        createdAt: 3000,
    })
    assert.equal(reduceMembershipOperation(staleEpoch, active, { baseKey }).reason, 'wrong-previous-epoch')

    const wrongRecipientGrant = createEpochGrants({
        epochKey: epoch2,
        recipients: [{
            writerKey: guestWriterKey,
            epochPublicKey: epochPublicKeyHex(guestEpoch),
        }],
    })
    const missingGrant = createRemoveWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: guestWriterKey,
        baseKey,
        sequence: 3,
        previousEpoch: 1,
        epoch: 2,
        epochKey: epoch2,
        epochGrants: wrongRecipientGrant,
        createdAt: 3000,
    })
    assert.equal(reduceMembershipOperation(missingGrant, active, { baseKey }).reason, 'missing-epoch-grant')
})

test('membership roster lists writers owner-first and marks self and admin rights', () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const state = reduceMembershipLog([
        createOwnerBootstrapRecord({
            ownerAuthorityKeyPair: owner,
            writerKey: ownerWriterKey,
            baseKey,
            epochPublicKey: epochPublicKeyHex(ownerEpoch),
            epochKey: generateEpochKey(),
            createdAt: 1000,
        }),
        createAddWriterMembershipRecord({
            ownerAuthorityKeyPair: owner,
            writerKey: guestWriterKey,
            baseKey,
            sequence: 2,
            epochPublicKey: epochPublicKeyHex(guestEpoch),
            createdAt: 2000,
        }),
    ], { baseKey })

    const roster = buildMembershipRoster(state, {
        localWriterKey: guestWriterKey.toString('hex'),
        hasOwnerAuthority: false,
    })

    assert.equal(roster.currentEpoch, 1)
    assert.equal(roster.canAdminister, false)
    assert.equal(roster.ownerWriterKey, ownerWriterKey.toString('hex'))
    assert.equal(roster.writers.length, 2)
    // Owner is listed first.
    assert.equal(roster.writers[0].writerKey, ownerWriterKey.toString('hex'))
    assert.equal(roster.writers[0].isOwner, true)
    assert.equal(roster.writers[0].isSelf, false)
    // The guest device sees itself flagged.
    assert.equal(roster.writers[1].writerKey, guestWriterKey.toString('hex'))
    assert.equal(roster.writers[1].isOwner, false)
    assert.equal(roster.writers[1].isSelf, true)

    // The owner device holding authority can administer.
    const ownerRoster = buildMembershipRoster(state, {
        localWriterKey: ownerWriterKey.toString('hex'),
        hasOwnerAuthority: true,
    })
    assert.equal(ownerRoster.canAdminister, true)
    assert.equal(ownerRoster.writers[0].isSelf, true)
})
