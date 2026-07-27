import test from 'node:test'
import assert from 'node:assert/strict'
import { createEpochKeyring, resolveActiveEpochKey } from './epoch-keyring.mjs'
import { generateEpochKey, epochKeyHashHex } from './key-epochs.mjs'

const state = (fields = {}) => ({
    currentEpoch: 1,
    currentEpochKeyHash: null,
    removedWriters: new Map(),
    ...fields,
})

test('the keyring files keys by their membership-log hash', () => {
    const keyring = createEpochKeyring()
    const key = generateEpochKey()
    const hash = keyring.remember(key)

    assert.equal(hash, epochKeyHashHex(key))
    assert.equal(keyring.has(hash), true)
    assert.equal(keyring.forHash(hash), key)
    assert.equal(keyring.size, 1)
})

test('the keyring ignores values that are not epoch keys', () => {
    const keyring = createEpochKeyring()
    assert.equal(keyring.remember(null), null)
    assert.equal(keyring.remember(Buffer.alloc(8)), null)
    assert.equal(keyring.size, 0)
    assert.equal(keyring.forHash(null), null)
    assert.equal(keyring.forHash('not-a-hash'), null)
})

test('remembering the same key twice keeps one entry', () => {
    const keyring = createEpochKeyring()
    const key = generateEpochKey()
    keyring.remember(key)
    keyring.remember(Buffer.from(key))
    assert.equal(keyring.size, 1)
})

test('no committed epoch means no change', () => {
    const keyring = createEpochKeyring()
    assert.equal(resolveActiveEpochKey({
        keyring, membershipState: state(), currentKey: generateEpochKey(), localWriterKey: 'aa',
    }), null)
})

test('holding the committed epoch key already means no change', () => {
    const keyring = createEpochKeyring()
    const key = generateEpochKey()
    keyring.remember(key)
    assert.equal(resolveActiveEpochKey({
        keyring,
        membershipState: state({ currentEpochKeyHash: epochKeyHashHex(key) }),
        currentKey: key,
        localWriterKey: 'aa',
    }), null)
})

test('a rotated epoch adopts the granted key from the keyring', () => {
    const keyring = createEpochKeyring()
    const oldKey = generateEpochKey()
    const newKey = generateEpochKey()
    keyring.remember(oldKey)
    keyring.remember(newKey)

    const decision = resolveActiveEpochKey({
        keyring,
        membershipState: state({ currentEpoch: 2, currentEpochKeyHash: epochKeyHashHex(newKey) }),
        currentKey: oldKey,
        localWriterKey: 'aa',
    })
    assert.deepEqual(decision, { key: newKey, reason: 'rotated' })
})

test('a reorder back to the previous epoch restores the previous key', () => {
    // The whole point of retaining the material: the pointer moves back.
    const keyring = createEpochKeyring()
    const oldKey = generateEpochKey()
    const newKey = generateEpochKey()
    keyring.remember(oldKey)
    keyring.remember(newKey)

    const decision = resolveActiveEpochKey({
        keyring,
        membershipState: state({ currentEpoch: 1, currentEpochKeyHash: epochKeyHashHex(oldKey) }),
        currentKey: newKey,
        localWriterKey: 'aa',
    })
    assert.deepEqual(decision, { key: oldKey, reason: 'rotated' })
})

test('an epoch we were never granted leaves the current key alone', () => {
    // Dropping it would only cost us the ability to read history we already
    // replicated, and would not produce the key we are missing.
    const keyring = createEpochKeyring()
    const held = generateEpochKey()
    keyring.remember(held)

    assert.equal(resolveActiveEpochKey({
        keyring,
        membershipState: state({ currentEpoch: 2, currentEpochKeyHash: epochKeyHashHex(generateEpochKey()) }),
        currentKey: held,
        localWriterKey: 'aa',
    }), null)
})

test('a removed local writer gives up its active key', () => {
    const keyring = createEpochKeyring()
    const key = generateEpochKey()
    keyring.remember(key)

    const decision = resolveActiveEpochKey({
        keyring,
        membershipState: state({
            currentEpochKeyHash: epochKeyHashHex(key),
            removedWriters: new Map([['aa', { epoch: 2 }]]),
        }),
        currentKey: key,
        localWriterKey: 'aa',
    })
    assert.deepEqual(decision, { key: null, reason: 'removed' })
})

test('a removal that a reorder undoes re-adopts the retained key', () => {
    const keyring = createEpochKeyring()
    const key = generateEpochKey()
    keyring.remember(key)

    const decision = resolveActiveEpochKey({
        keyring,
        membershipState: state({ currentEpochKeyHash: epochKeyHashHex(key) }),
        currentKey: null,
        localWriterKey: 'aa',
    })
    assert.deepEqual(decision, { key, reason: 'adopted' })
})

test('a removed writer with no active key needs no change', () => {
    const keyring = createEpochKeyring()
    assert.equal(resolveActiveEpochKey({
        keyring,
        membershipState: state({ removedWriters: new Map([['aa', { epoch: 2 }]]) }),
        currentKey: null,
        localWriterKey: 'aa',
    }), null)
})

test('another writer being removed does not touch this device', () => {
    const keyring = createEpochKeyring()
    const key = generateEpochKey()
    keyring.remember(key)
    assert.equal(resolveActiveEpochKey({
        keyring,
        membershipState: state({
            currentEpochKeyHash: epochKeyHashHex(key),
            removedWriters: new Map([['bb', { epoch: 2 }]]),
        }),
        currentKey: key,
        localWriterKey: 'aa',
    }), null)
})

test('missing arguments resolve to no change rather than throwing', () => {
    assert.equal(resolveActiveEpochKey(), null)
    assert.equal(resolveActiveEpochKey({}), null)
    assert.equal(resolveActiveEpochKey({ membershipState: state() }), null)
})
