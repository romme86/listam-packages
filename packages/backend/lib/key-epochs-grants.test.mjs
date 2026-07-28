import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createEncryptedListOperation,
    createEpochEncryptionKeyPair,
    createEpochGrants,
    decryptEncryptedListOperation,
    decryptEpochGrantForWriter,
    epochKeyHashHex,
    epochPublicKeyHex,
    generateEpochKey,
} from './key-epochs.mjs'

const writerA = Buffer.from('a'.repeat(64), 'hex')
const writerB = Buffer.from('b'.repeat(64), 'hex')

test('epoch grants only open for the intended writer key pair', () => {
    const epochKey = generateEpochKey()
    const memberA = createEpochEncryptionKeyPair()
    const memberB = createEpochEncryptionKeyPair()
    const grants = createEpochGrants({
        epochKey,
        recipients: [
            { writerKey: writerA, epochPublicKey: epochPublicKeyHex(memberA) },
        ],
    })

    assert.equal(grants.length, 1)
    assert.equal(decryptEpochGrantForWriter(grants, writerA, memberA).toString('hex'), epochKey.toString('hex'))
    assert.equal(decryptEpochGrantForWriter(grants, writerA, memberB), null)
    assert.equal(decryptEpochGrantForWriter(grants, writerB, memberA), null)
})

test('encrypted list operations require the matching epoch key and authenticated epoch', () => {
    const epochKey = generateEpochKey()
    const previousEpochKey = generateEpochKey()
    const op = { type: 'add', value: { text: 'Milk', isDone: false, timeOfCompletion: 0 } }
    const encrypted = createEncryptedListOperation(op, epochKey, 2)

    assert.deepEqual(decryptEncryptedListOperation(encrypted, epochKey), op)
    assert.equal(decryptEncryptedListOperation(encrypted, previousEpochKey), null)
    assert.equal(decryptEncryptedListOperation({ ...encrypted, epoch: 1 }, epochKey), null)
})

test('epoch key hashes are deterministic without exposing the key', () => {
    const epochKey = Buffer.from('c'.repeat(64), 'hex')

    assert.equal(epochKeyHashHex(epochKey), epochKeyHashHex(Buffer.from(epochKey)))
    assert.notEqual(epochKeyHashHex(epochKey), epochKey.toString('hex'))
})
