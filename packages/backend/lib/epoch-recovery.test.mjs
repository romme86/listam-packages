import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createAddWriterMembershipRecord,
    createOwnerAuthorityKeyPair,
    createOwnerBootstrapRecord,
    createRemoveWriterMembershipRecord,
} from './membership.mjs'
import { createEpochEncryptionKeyPair, createEpochGrants, generateEpochKey } from './key-epochs.mjs'
import { recoverEpochKeyFromMembership } from './epoch-recovery.mjs'

const BASE_KEY = 'ab'.repeat(32)
const OWNER_WRITER = '11'.repeat(32)
const ACTIVE_WRITER = '22'.repeat(32)
const REMOVED_WRITER = '33'.repeat(32)

test('restart replay recovers the current epoch key from a persisted grant', () => {
    const authority = createOwnerAuthorityKeyPair()
    const ownerEpochKeys = createEpochEncryptionKeyPair()
    const activeEpochKeys = createEpochEncryptionKeyPair()
    const removedEpochKeys = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const epoch2 = generateEpochKey()
    const records = [
        createOwnerBootstrapRecord({ ownerAuthorityKeyPair: authority, writerKey: OWNER_WRITER, baseKey: BASE_KEY, epochPublicKey: ownerEpochKeys.publicKey, epochKey: epoch1 }),
        createAddWriterMembershipRecord({ ownerAuthorityKeyPair: authority, writerKey: ACTIVE_WRITER, baseKey: BASE_KEY, sequence: 2, epochPublicKey: activeEpochKeys.publicKey }),
        createAddWriterMembershipRecord({ ownerAuthorityKeyPair: authority, writerKey: REMOVED_WRITER, baseKey: BASE_KEY, sequence: 3, epochPublicKey: removedEpochKeys.publicKey }),
        createRemoveWriterMembershipRecord({
            ownerAuthorityKeyPair: authority,
            writerKey: REMOVED_WRITER,
            baseKey: BASE_KEY,
            sequence: 4,
            previousEpoch: 1,
            epoch: 2,
            epochKey: epoch2,
            epochGrants: createEpochGrants({ epochKey: epoch2, recipients: [
                { writerKey: OWNER_WRITER, epochPublicKey: ownerEpochKeys.publicKey },
                { writerKey: ACTIVE_WRITER, epochPublicKey: activeEpochKeys.publicKey },
            ] }),
        }),
    ]

    const result = recoverEpochKeyFromMembership(records, {
        baseKey: BASE_KEY,
        localWriterKey: ACTIVE_WRITER,
        epochEncryptionKeyPair: activeEpochKeys,
        currentEpochKey: epoch1,
    })
    assert.equal(result.state.currentEpoch, 2)
    assert.equal(result.recovered, true)
    assert.deepEqual(result.epochKey, epoch2)
})

test('restart replay never grants the rotated key to the removed writer', () => {
    const authority = createOwnerAuthorityKeyPair()
    const ownerEpochKeys = createEpochEncryptionKeyPair()
    const removedEpochKeys = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const epoch2 = generateEpochKey()
    const records = [
        createOwnerBootstrapRecord({ ownerAuthorityKeyPair: authority, writerKey: OWNER_WRITER, baseKey: BASE_KEY, epochPublicKey: ownerEpochKeys.publicKey, epochKey: epoch1 }),
        createAddWriterMembershipRecord({ ownerAuthorityKeyPair: authority, writerKey: REMOVED_WRITER, baseKey: BASE_KEY, sequence: 2, epochPublicKey: removedEpochKeys.publicKey }),
        createRemoveWriterMembershipRecord({
            ownerAuthorityKeyPair: authority,
            writerKey: REMOVED_WRITER,
            baseKey: BASE_KEY,
            sequence: 3,
            previousEpoch: 1,
            epoch: 2,
            epochKey: epoch2,
            epochGrants: createEpochGrants({ epochKey: epoch2, recipients: [
                { writerKey: OWNER_WRITER, epochPublicKey: ownerEpochKeys.publicKey },
            ] }),
        }),
    ]

    const result = recoverEpochKeyFromMembership(records, {
        baseKey: BASE_KEY,
        localWriterKey: REMOVED_WRITER,
        epochEncryptionKeyPair: removedEpochKeys,
        currentEpochKey: epoch1,
    })
    assert.equal(result.recovered, false)
    assert.deepEqual(result.epochKey, epoch1)
})
