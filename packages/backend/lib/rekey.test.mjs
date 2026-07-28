import test from 'node:test'
import assert from 'node:assert/strict'
import { performMemberRemovalRekey } from './rekey.mjs'
import {
    createAddWriterMembershipRecord,
    createOwnerAuthorityKeyPair,
    createOwnerBootstrapRecord,
    reduceMembershipLog,
    reduceMembershipOperation,
} from './membership.mjs'
import {
    createEpochEncryptionKeyPair,
    epochKeyHashHex,
    epochPublicKeyHex,
    generateEpochKey,
} from './key-epochs.mjs'
import { createListOperation } from '@listam/domain/list-reducer'

const baseKey = Buffer.from('ab'.repeat(32), 'hex')
const ownerWriterKey = Buffer.from('11'.repeat(32), 'hex')
const guestWriterKey = Buffer.from('22'.repeat(32), 'hex')
const thirdWriterKey = Buffer.from('33'.repeat(32), 'hex')
const currentList = [{ text: 'Milk', isDone: false, timeOfCompletion: 0 }]

// Build a realistic active membership state (owner + guest, both with epoch
// public keys, currentEpoch 1) using the real record builders and reducer, so
// the orchestration is exercised against genuine membership records — not a
// hand-rolled mock that could drift from what apply() actually produces.
function activeOwnerGuestState(owner, ownerEpoch, guestEpoch, epoch1, { extraWriters = [] } = {}) {
    const records = [
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
        ...extraWriters,
    ]
    return reduceMembershipLog(records, { baseKey })
}

// A spying dependency bundle. `appendBehavior[i] === 'throw'` makes the i-th
// (1-based) autobase.append call reject, which is how we simulate an
// interrupted re-key at a chosen point.
function makeHarness({ state, owner, epochKey, writable = true, appendBehavior = [], snapshotRetries, trackEnqueue = false } = {}) {
    const calls = {
        appends: [],
        snapshots: [],
        setEpochKey: [],
        saveEpochKey: [],
        deleteEpochKey: 0,
        setMembershipState: 0,
        enqueueWrite: 0,
    }
    let appendCount = 0

    const autobase = {
        writable,
        key: baseKey,
        async append(op) {
            appendCount += 1
            calls.appends.push(op)
            if (appendBehavior[appendCount - 1] === 'throw') {
                throw new Error(`append #${appendCount} failed`)
            }
        },
        async update() {},
    }

    const deps = {
        autobase,
        epochKey,
        membershipState: state,
        ownerAuthorityKeyPair: owner,
        getCurrentList: () => currentList,
        prepareListAppendOperation(op) {
            calls.snapshots.push(op)
            return { snapshotOp: op }
        },
        setEpochKey(key) {
            calls.setEpochKey.push(key ? key.toString('hex') : null)
        },
        async saveEpochKey(key) {
            calls.saveEpochKey.push(key.toString('hex'))
            return true
        },
        async deleteEpochKey() {
            calls.deleteEpochKey += 1
        },
        setMembershipState() {
            calls.setMembershipState += 1
        },
        logger: { log() {} },
    }
    if (snapshotRetries !== undefined) deps.snapshotRetries = snapshotRetries
    if (trackEnqueue) {
        deps.enqueueWrite = (fn) => {
            calls.enqueueWrite += 1
            return fn()
        }
    }

    return { deps, calls }
}

test('re-key removes the writer, advances the epoch, and the emitted record verifies', async () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const state = activeOwnerGuestState(owner, ownerEpoch, guestEpoch, epoch1)
    const { deps, calls } = makeHarness({ state, owner, epochKey: epoch1 })

    const result = await performMemberRemovalRekey(guestWriterKey, deps)

    assert.deepEqual(result, { ok: true, committed: true, snapshot: true, epoch: 2 })
    // Exactly one forward rotation; no rollback.
    assert.equal(calls.setEpochKey.length, 1)
    assert.equal(calls.saveEpochKey.length, 1)
    assert.equal(calls.setMembershipState, 0)
    assert.equal(calls.deleteEpochKey, 0)
    // Membership record first, then the re-encrypted snapshot.
    assert.equal(calls.appends.length, 2)
    assert.equal(calls.snapshots.length, 1)
    assert.deepEqual(calls.appends[1], { snapshotOp: createListOperation('list', currentList) })

    // The membership record actually applies: it removes the guest and rotates
    // to epoch 2, and its epoch-key hash matches the rotated key that was saved.
    const rotatedKey = Buffer.from(calls.saveEpochKey[0], 'hex')
    const applied = reduceMembershipOperation(calls.appends[0], state, { baseKey })
    assert.equal(applied.ok, true)
    assert.equal(applied.state.currentEpoch, 2)
    assert.equal(applied.state.writers.has(guestWriterKey.toString('hex')), false)
    assert.equal(applied.state.writers.has(ownerWriterKey.toString('hex')), true)
    assert.equal(calls.appends[0].epochKeyHash, epochKeyHashHex(rotatedKey))
})

test('re-key rolls back to the previous epoch when a remaining writer has no epoch public key', async () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    // A third writer that joined without an epoch public key: removing the guest
    // would leave it un-grantable, so the re-key must abort before committing.
    const addThird = createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: owner,
        writerKey: thirdWriterKey,
        baseKey,
        sequence: 3,
        createdAt: 3000,
    })
    const state = activeOwnerGuestState(owner, ownerEpoch, guestEpoch, epoch1, { extraWriters: [addThird] })
    const { deps, calls } = makeHarness({ state, owner, epochKey: epoch1 })

    const result = await performMemberRemovalRekey(guestWriterKey, deps)

    // The failure is detected during the build phase, before any state changes,
    // so it aborts cleanly with nothing to roll back.
    assert.deepEqual(result, { ok: false, committed: false, snapshot: false, reason: 'precommit-failed' })
    assert.equal(calls.appends.length, 0)
    assert.equal(calls.setMembershipState, 0)
    assert.deepEqual(calls.setEpochKey, [])
    assert.deepEqual(calls.saveEpochKey, [])
    assert.equal(calls.deleteEpochKey, 0)
})

test('re-key rotation runs as a single serialized write unit', async () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const state = activeOwnerGuestState(owner, ownerEpoch, guestEpoch, epoch1)
    const { deps, calls } = makeHarness({ state, owner, epochKey: epoch1, trackEnqueue: true })

    const result = await performMemberRemovalRekey(guestWriterKey, deps)

    assert.equal(result.ok, true)
    // The membership append + snapshot append both happen inside exactly one
    // enqueueWrite unit, so a concurrent list write cannot interleave between
    // the epoch advance and the snapshot.
    assert.equal(calls.enqueueWrite, 1)
    assert.equal(calls.appends.length, 2)
})

test('re-key rolls back the rotated epoch when the membership append fails before commit', async () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const state = activeOwnerGuestState(owner, ownerEpoch, guestEpoch, epoch1)
    // The first append (the membership record) fails.
    const { deps, calls } = makeHarness({ state, owner, epochKey: epoch1, appendBehavior: ['throw'] })

    const result = await performMemberRemovalRekey(guestWriterKey, deps)

    assert.deepEqual(result, { ok: false, committed: false, snapshot: false, reason: 'rolled-back' })
    assert.equal(calls.appends.length, 1)        // membership attempted, threw
    assert.equal(calls.snapshots.length, 0)      // snapshot never reached
    assert.equal(calls.setMembershipState, 1)    // membership state restored
    // Forward-rotated, then restored: last value is the previous epoch key.
    const rotatedHex = calls.saveEpochKey[0]
    assert.notEqual(rotatedHex, epoch1.toString('hex'))
    assert.deepEqual(calls.setEpochKey, [rotatedHex, epoch1.toString('hex')])
    assert.deepEqual(calls.saveEpochKey, [rotatedHex, epoch1.toString('hex')])
    assert.equal(calls.deleteEpochKey, 0)
})

test('re-key rollback deletes the rotated key when there was no previous epoch key', async () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const state = activeOwnerGuestState(owner, ownerEpoch, guestEpoch, epoch1)
    const { deps, calls } = makeHarness({ state, owner, epochKey: null, appendBehavior: ['throw'] })

    const result = await performMemberRemovalRekey(guestWriterKey, deps)

    assert.equal(result.ok, false)
    assert.equal(result.committed, false)
    // Forward saved the rotated key, then rollback deleted it (no prior to restore).
    assert.equal(calls.saveEpochKey.length, 1)
    assert.equal(calls.deleteEpochKey, 1)
    assert.deepEqual(calls.setEpochKey, [calls.saveEpochKey[0], null])
})

test('a snapshot failure after commit is retried and does NOT roll back the removal', async () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const state = activeOwnerGuestState(owner, ownerEpoch, guestEpoch, epoch1)
    // Membership append (call 1) succeeds; all 3 snapshot attempts (calls 2-4) fail.
    const { deps, calls } = makeHarness({
        state,
        owner,
        epochKey: epoch1,
        appendBehavior: [null, 'throw', 'throw', 'throw'],
        snapshotRetries: 2,
    })

    const result = await performMemberRemovalRekey(guestWriterKey, deps)

    assert.deepEqual(result, { ok: true, committed: true, snapshot: false, reason: 'snapshot-incomplete', epoch: 2 })
    // The committed removal is NOT rolled back: epoch stays rotated.
    assert.equal(calls.setMembershipState, 0)
    assert.equal(calls.deleteEpochKey, 0)
    assert.equal(calls.setEpochKey.length, 1)
    assert.equal(calls.saveEpochKey.length, 1)
    // 1 membership append + 3 snapshot attempts (initial + 2 retries).
    assert.equal(calls.appends.length, 4)
    assert.equal(calls.snapshots.length, 3)
})

test('a snapshot append that succeeds on retry reports a full success', async () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const state = activeOwnerGuestState(owner, ownerEpoch, guestEpoch, epoch1)
    // Membership ok, first snapshot attempt fails, second succeeds.
    const { deps, calls } = makeHarness({
        state,
        owner,
        epochKey: epoch1,
        appendBehavior: [null, 'throw', null],
        snapshotRetries: 2,
    })

    const result = await performMemberRemovalRekey(guestWriterKey, deps)

    assert.deepEqual(result, { ok: true, committed: true, snapshot: true, epoch: 2 })
    assert.equal(calls.setMembershipState, 0)
    assert.equal(calls.appends.length, 3) // 1 membership + 2 snapshot attempts
    assert.equal(calls.snapshots.length, 2)
})

test('re-key rejects bad input and unauthorized callers without touching any state', async () => {
    const owner = createOwnerAuthorityKeyPair()
    const ownerEpoch = createEpochEncryptionKeyPair()
    const guestEpoch = createEpochEncryptionKeyPair()
    const epoch1 = generateEpochKey()
    const state = activeOwnerGuestState(owner, ownerEpoch, guestEpoch, epoch1)

    const assertGuard = (result, reason, calls) => {
        assert.deepEqual(result, { ok: false, committed: false, snapshot: false, reason })
        assert.equal(calls.appends.length, 0)
        assert.equal(calls.setEpochKey.length, 0)
        assert.equal(calls.saveEpochKey.length, 0)
        assert.equal(calls.setMembershipState, 0)
        assert.equal(calls.deleteEpochKey, 0)
    }

    const invalid = makeHarness({ state, owner, epochKey: epoch1 })
    assertGuard(await performMemberRemovalRekey('not-a-key', invalid.deps), 'invalid-writer-key', invalid.calls)

    const notWritable = makeHarness({ state, owner, epochKey: epoch1, writable: false })
    assertGuard(await performMemberRemovalRekey(guestWriterKey, notWritable.deps), 'not-writable', notWritable.calls)

    const notOwner = makeHarness({ state, owner: createOwnerAuthorityKeyPair(), epochKey: epoch1 })
    assertGuard(await performMemberRemovalRekey(guestWriterKey, notOwner.deps), 'not-owner', notOwner.calls)

    const unknownWriter = makeHarness({ state, owner, epochKey: epoch1 })
    assertGuard(await performMemberRemovalRekey(thirdWriterKey, unknownWriter.deps), 'unknown-writer', unknownWriter.calls)
})
