import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createAddWriterMembershipRecord,
    createEpochResyncMembershipRecord,
    createOwnerAuthorityKeyPair,
    createOwnerBootstrapRecord,
    createRemoveWriterMembershipRecord,
    nextMembershipSequence,
    reduceMembershipLog,
    reduceMembershipOperation,
} from './membership.mjs'
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
import { epochResyncRecordMatchesMembership, performEpochResync } from './epoch-resync.mjs'
import { recoverEpochKeyFromMembership } from './epoch-recovery.mjs'
import { validateDirectEpochGrant } from './epoch-direct-adoption.mjs'
import { createListOperation, reduceListOperations } from './list-reducer.mjs'

const BASE_KEY = 'ab'.repeat(32)
const OWNER_WRITER = '11'.repeat(32)
const ACTIVE_WRITER = '22'.repeat(32)
const REMOVED_WRITER = '33'.repeat(32)

function activeFixture() {
    const ownerAuthority = createOwnerAuthorityKeyPair()
    const ownerEpochKeys = createEpochEncryptionKeyPair()
    const activeEpochKeys = createEpochEncryptionKeyPair()
    const epochKey = generateEpochKey()
    const records = [
        createOwnerBootstrapRecord({
            ownerAuthorityKeyPair: ownerAuthority,
            writerKey: OWNER_WRITER,
            baseKey: BASE_KEY,
            epochPublicKey: epochPublicKeyHex(ownerEpochKeys),
            epochKey,
            createdAt: 1000,
        }),
        createAddWriterMembershipRecord({
            ownerAuthorityKeyPair: ownerAuthority,
            writerKey: ACTIVE_WRITER,
            baseKey: BASE_KEY,
            sequence: 2,
            epochPublicKey: epochPublicKeyHex(activeEpochKeys),
            createdAt: 2000,
        }),
    ]
    return {
        ownerAuthority,
        ownerEpochKeys,
        activeEpochKeys,
        epochKey,
        state: reduceMembershipLog(records, { baseKey: BASE_KEY }),
    }
}

test('owner resync seals the current epoch and emits merge-safe item repairs', async () => {
    const fixture = activeFixture()
    const appended = []
    const items = [
        { id: 'task', listId: 'default', listType: 'todo', text: 'Task', isDone: false, timeOfCompletion: 0, updatedAt: 1 },
        { id: 'i:default::task', listId: '__plan__', listType: 'plan', text: 'i:default::task', isDone: false, timeOfCompletion: 0, updatedAt: 2, plannedFor: '2026-07-20' },
    ]
    const autobase = {
        writable: true,
        key: Buffer.from(BASE_KEY, 'hex'),
        async append(value) { appended.push(value) },
        async update() {},
    }

    const result = await performEpochResync({
        autobase,
        epochKey: fixture.epochKey,
        membershipState: fixture.state,
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        getAllItems: async () => items,
        prepareListAppendOperation: (op) => createEncryptedListOperation(op, fixture.epochKey, fixture.state.currentEpoch),
        enqueueWrite: (fn) => fn(),
        logger: { log() {} },
    })

    assert.equal(result.ok, true)
    assert.equal(result.snapshotCount, 2)
    assert.equal(appended.length, 3)
    assert.equal(result.grantRecord, appended[0])

    const grantResult = reduceMembershipOperation(appended[0], fixture.state, { baseKey: BASE_KEY })
    assert.equal(grantResult.ok, true)
    assert.equal(grantResult.effect.epochResynced, true)
    assert.equal(grantResult.state.currentEpochKeyHash, epochKeyHashHex(fixture.epochKey))
    assert.deepEqual(
        decryptEpochGrantForWriter(grantResult.effect.epochGrants, ACTIVE_WRITER, fixture.activeEpochKeys),
        fixture.epochKey,
    )

    const repairs = appended.slice(1).map((record) => decryptEncryptedListOperation(record, fixture.epochKey))
    assert.deepEqual(new Set(repairs.map((op) => op.listId)), new Set(['default', '__plan__']))
    assert.ok(repairs.every((op) => op.type === 'update'))

    // Regression: the old per-list snapshot cleared this peer addition when the
    // stale owner capture linearized after it. Individual updates keep unrelated
    // additions and cannot roll back a newer same-id edit.
    const francese = { id: 'francese', listId: 'default', listType: 'todo', text: 'Francese', isDone: false, timeOfCompletion: 0, updatedAt: 10 }
    const newerTask = { ...items[0], text: 'Task edited on peer', updatedAt: 20 }
    const reduced = reduceListOperations([
        createListOperation('add', francese),
        createListOperation('add', newerTask),
        ...repairs,
    ]).items
    assert.equal(reduced.find((item) => item.id === 'francese')?.text, 'Francese')
    assert.equal(reduced.find((item) => item.id === 'task')?.text, 'Task edited on peer')
    assert.equal(reduced.find((item) => item.id === 'task')?.updatedAt, 20)
})

test('a cached direct grant is reused only for the same epoch and active writer set', async () => {
    const fixture = activeFixture()
    const appended = []
    const result = await performEpochResync({
        autobase: { writable: true, key: Buffer.from(BASE_KEY, 'hex'), async append(v) { appended.push(v) }, async update() {} },
        epochKey: fixture.epochKey,
        membershipState: fixture.state,
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        getAllItems: async () => [],
        prepareListAppendOperation: (op) => op,
        logger: { log() {} },
    })
    assert.equal(epochResyncRecordMatchesMembership(result.grantRecord, fixture.state), true)

    const expanded = reduceMembershipOperation(createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        writerKey: REMOVED_WRITER,
        baseKey: BASE_KEY,
        sequence: nextMembershipSequence(fixture.state),
        epochPublicKey: epochPublicKeyHex(createEpochEncryptionKeyPair()),
        createdAt: 3000,
    }), fixture.state, { baseKey: BASE_KEY }).state
    assert.equal(epochResyncRecordMatchesMembership(result.grantRecord, expanded), false)
    assert.equal(epochResyncRecordMatchesMembership({ ...result.grantRecord, epoch: 2 }, fixture.state), false)
})

test('owner publishes and awaits the direct grant before item repairs', async () => {
    const fixture = activeFixture()
    const events = []
    const result = await performEpochResync({
        autobase: {
            writable: true,
            key: Buffer.from(BASE_KEY, 'hex'),
            async append(value) { events.push(value.type === 'membership' ? 'membership' : 'repair') },
            async update() { events.push('update') },
        },
        epochKey: fixture.epochKey,
        membershipState: fixture.state,
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        getAllItems: async () => [
            { id: 'task', listId: 'default', listType: 'todo', text: 'Task', isDone: false, timeOfCompletion: 0, updatedAt: 1 },
        ],
        prepareListAppendOperation: (op) => createEncryptedListOperation(op, fixture.epochKey, 1),
        publishGrant: async (record) => {
            assert.equal(record.action, 'resync-epoch')
            events.push('grant-ack')
            return { attempted: 1, acknowledged: 1 }
        },
        logger: { log() {} },
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.grantDelivery, { attempted: 1, acknowledged: 1 })
    assert.ok(events.indexOf('grant-ack') < events.indexOf('repair'))
})

test('offline restart replay adopts a resync grant from the full membership log', () => {
    const fixture = activeFixture()
    const grants = createEpochGrants({ epochKey: fixture.epochKey, recipients: [
        { writerKey: OWNER_WRITER, epochPublicKey: epochPublicKeyHex(fixture.ownerEpochKeys) },
        { writerKey: ACTIVE_WRITER, epochPublicKey: epochPublicKeyHex(fixture.activeEpochKeys) },
    ] })
    const resync = createEpochResyncMembershipRecord({
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        writerKey: OWNER_WRITER,
        baseKey: BASE_KEY,
        sequence: 3,
        epoch: 1,
        epochKey: fixture.epochKey,
        epochGrants: grants,
        createdAt: 3000,
    })
    const staleKey = generateEpochKey()
    const history = [
        createOwnerBootstrapRecord({
            ownerAuthorityKeyPair: fixture.ownerAuthority,
            writerKey: OWNER_WRITER,
            baseKey: BASE_KEY,
            epochPublicKey: epochPublicKeyHex(fixture.ownerEpochKeys),
            epochKey: staleKey,
            createdAt: 1000,
        }),
        createAddWriterMembershipRecord({
            ownerAuthorityKeyPair: fixture.ownerAuthority,
            writerKey: ACTIVE_WRITER,
            baseKey: BASE_KEY,
            sequence: 2,
            epochPublicKey: epochPublicKeyHex(fixture.activeEpochKeys),
            createdAt: 2000,
        }),
        resync,
    ]
    const replay = recoverEpochKeyFromMembership(history, {
        baseKey: BASE_KEY,
        localWriterKey: ACTIVE_WRITER,
        epochEncryptionKeyPair: fixture.activeEpochKeys,
        currentEpochKey: staleKey,
    })
    assert.equal(replay.recovered, true)
    assert.deepEqual(replay.epochKey, fixture.epochKey)
})

test('direct adoption opens an owner-signed grant for the authorized local writer', () => {
    const fixture = activeFixture()
    const record = createEpochResyncMembershipRecord({
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        writerKey: OWNER_WRITER,
        baseKey: BASE_KEY,
        sequence: nextMembershipSequence(fixture.state),
        epoch: 1,
        epochKey: fixture.epochKey,
        epochGrants: createEpochGrants({ epochKey: fixture.epochKey, recipients: [
            { writerKey: OWNER_WRITER, epochPublicKey: epochPublicKeyHex(fixture.ownerEpochKeys) },
            { writerKey: ACTIVE_WRITER, epochPublicKey: epochPublicKeyHex(fixture.activeEpochKeys) },
        ] }),
        createdAt: 3000,
    })
    const adopted = validateDirectEpochGrant(record, {
        membershipState: fixture.state,
        baseKey: BASE_KEY,
        localWriterKey: ACTIVE_WRITER,
        epochEncryptionKeyPair: fixture.activeEpochKeys,
        currentEpochKey: generateEpochKey(),
    })
    assert.equal(adopted.ok, true)
    assert.equal(adopted.alreadyAdopted, false)
    assert.deepEqual(adopted.epochKey, fixture.epochKey)
})

test('direct adoption rejects a signed grant when this device is not a sealed recipient', () => {
    const fixture = activeFixture()
    const strangerKeys = createEpochEncryptionKeyPair()
    const record = createEpochResyncMembershipRecord({
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        writerKey: OWNER_WRITER,
        baseKey: BASE_KEY,
        sequence: nextMembershipSequence(fixture.state),
        epoch: 1,
        epochKey: fixture.epochKey,
        epochGrants: createEpochGrants({ epochKey: fixture.epochKey, recipients: [
            { writerKey: OWNER_WRITER, epochPublicKey: epochPublicKeyHex(fixture.ownerEpochKeys) },
            { writerKey: ACTIVE_WRITER, epochPublicKey: epochPublicKeyHex(fixture.activeEpochKeys) },
        ] }),
        createdAt: 3000,
    })
    const rejected = validateDirectEpochGrant(record, {
        membershipState: fixture.state,
        baseKey: BASE_KEY,
        localWriterKey: ACTIVE_WRITER,
        epochEncryptionKeyPair: strangerKeys,
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.reason, 'not-recipient')
})

test('epoch resync grants exclude removed writers', async () => {
    const fixture = activeFixture()
    const removedEpochKeys = createEpochEncryptionKeyPair()
    const withRemoved = reduceMembershipOperation(createAddWriterMembershipRecord({
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        writerKey: REMOVED_WRITER,
        baseKey: BASE_KEY,
        sequence: 3,
        epochPublicKey: epochPublicKeyHex(removedEpochKeys),
        createdAt: 3000,
    }), fixture.state, { baseKey: BASE_KEY }).state
    const epoch2 = generateEpochKey()
    const removalGrants = createEpochGrants({ epochKey: epoch2, recipients: [
        { writerKey: OWNER_WRITER, epochPublicKey: epochPublicKeyHex(fixture.ownerEpochKeys) },
        { writerKey: ACTIVE_WRITER, epochPublicKey: epochPublicKeyHex(fixture.activeEpochKeys) },
    ] })
    const active = reduceMembershipOperation(createRemoveWriterMembershipRecord({
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        writerKey: REMOVED_WRITER,
        baseKey: BASE_KEY,
        sequence: 4,
        previousEpoch: 1,
        epoch: 2,
        epochKey: epoch2,
        epochGrants: removalGrants,
        createdAt: 4000,
    }), withRemoved, { baseKey: BASE_KEY }).state
    const appended = []

    const result = await performEpochResync({
        autobase: { writable: true, key: Buffer.from(BASE_KEY, 'hex'), async append(v) { appended.push(v) }, async update() {} },
        epochKey: epoch2,
        membershipState: active,
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        getAllItems: async () => [],
        prepareListAppendOperation: (op) => createEncryptedListOperation(op, epoch2, 2),
        logger: { log() {} },
    })

    assert.equal(result.ok, true)
    const reduced = reduceMembershipOperation(appended[0], active, { baseKey: BASE_KEY })
    assert.equal(reduced.ok, true)
    assert.equal(decryptEpochGrantForWriter(reduced.effect.epochGrants, ACTIVE_WRITER, fixture.activeEpochKeys).toString('hex'), epoch2.toString('hex'))
    assert.equal(decryptEpochGrantForWriter(reduced.effect.epochGrants, REMOVED_WRITER, removedEpochKeys), null)
    assert.deepEqual(reduced.effect.epochGrants.map((grant) => grant.writerKey).sort(), [ACTIVE_WRITER, OWNER_WRITER].sort())
})

test('non-owner resync cannot append grants or repairs', async () => {
    const fixture = activeFixture()
    let writes = 0
    const result = await performEpochResync({
        autobase: { writable: true, key: Buffer.from(BASE_KEY, 'hex'), async append() { writes++ }, async update() {} },
        epochKey: fixture.epochKey,
        membershipState: fixture.state,
        ownerAuthorityKeyPair: createOwnerAuthorityKeyPair(),
        getAllItems: async () => [],
        prepareListAppendOperation: (op) => op,
        logger: { log() {} },
    })
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'not-owner')
    assert.equal(writes, 0)
})

test('single-device bases do not append pointless resync records', async () => {
    const fixture = activeFixture()
    const single = reduceMembershipLog([
        createOwnerBootstrapRecord({
            ownerAuthorityKeyPair: fixture.ownerAuthority,
            writerKey: OWNER_WRITER,
            baseKey: BASE_KEY,
            epochPublicKey: epochPublicKeyHex(fixture.ownerEpochKeys),
            epochKey: fixture.epochKey,
            createdAt: 1000,
        }),
    ], { baseKey: BASE_KEY })
    let writes = 0
    const result = await performEpochResync({
        autobase: { writable: true, key: Buffer.from(BASE_KEY, 'hex'), async append() { writes++ }, async update() {} },
        epochKey: fixture.epochKey,
        membershipState: single,
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        getAllItems: async () => [],
        prepareListAppendOperation: (op) => op,
        logger: { log() {} },
    })
    assert.equal(result.reason, 'no-peer-writers')
    assert.equal(writes, 0)
})

test('owner resync never appends when the writer cannot flush', async () => {
    const fixture = activeFixture()
    let writes = 0
    let snapshots = 0
    const result = await performEpochResync({
        autobase: { writable: true, key: Buffer.from(BASE_KEY, 'hex'), async append() { writes++ }, async update() {} },
        epochKey: fixture.epochKey,
        membershipState: fixture.state,
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        getAllItems: async () => { snapshots++; return [] },
        prepareListAppendOperation: (op) => op,
        waitForFlushableWriter: async () => false,
        logger: { log() {} },
    })
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'sync-stalled')
    assert.equal(writes, 0)
    assert.equal(snapshots, 0)
})

test('malformed resync grants cannot omit or substitute an active writer', () => {
    const fixture = activeFixture()
    const grants = createEpochGrants({ epochKey: fixture.epochKey, recipients: [
        { writerKey: OWNER_WRITER, epochPublicKey: epochPublicKeyHex(fixture.ownerEpochKeys) },
        { writerKey: ACTIVE_WRITER, epochPublicKey: epochPublicKeyHex(fixture.activeEpochKeys) },
    ] })
    // Build both records through the signed constructor: even a correctly
    // signed owner record is rejected if it omits an active writer.
    const valid = createEpochResyncMembershipRecord({
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        writerKey: OWNER_WRITER,
        baseKey: BASE_KEY,
        sequence: nextMembershipSequence(fixture.state),
        epoch: fixture.state.currentEpoch,
        epochKey: fixture.epochKey,
        epochGrants: grants,
        createdAt: 9000,
    })
    assert.equal(reduceMembershipOperation(valid, fixture.state, { baseKey: BASE_KEY }).ok, true)
    const incomplete = createEpochResyncMembershipRecord({
        ownerAuthorityKeyPair: fixture.ownerAuthority,
        writerKey: OWNER_WRITER,
        baseKey: BASE_KEY,
        sequence: nextMembershipSequence(fixture.state),
        epoch: fixture.state.currentEpoch,
        epochKey: fixture.epochKey,
        epochGrants: grants.slice(0, 1),
        createdAt: 9000,
    })
    assert.equal(reduceMembershipOperation(incomplete, fixture.state, { baseKey: BASE_KEY }).reason, 'incomplete-epoch-grants')
})
