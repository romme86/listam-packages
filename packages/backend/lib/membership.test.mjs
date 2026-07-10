import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createOwnerAuthorityKeyPair,
    createOwnerBootstrapRecord,
    createAddWriterMembershipRecord,
    reduceMembershipLog,
    buildMembershipRoster,
} from './membership.mjs'

const BASE_KEY = 'ab'.repeat(32)
const OWNER_WRITER = '11'.repeat(32)
const WRITER_B = '22'.repeat(32)

function rosterFrom(records, localWriterKey = OWNER_WRITER) {
    const state = reduceMembershipLog(records, { baseKey: BASE_KEY })
    return { state, roster: buildMembershipRoster(state, { localWriterKey, writable: true, hasOwnerAuthority: true }) }
}

test('buildMembershipRoster surfaces joinedAt for the owner bootstrap and an added writer', () => {
    const owner = createOwnerAuthorityKeyPair()
    const bootstrap = createOwnerBootstrapRecord({ ownerAuthorityKeyPair: owner, writerKey: OWNER_WRITER, baseKey: BASE_KEY, createdAt: 1000 })
    const addB = createAddWriterMembershipRecord({ ownerAuthorityKeyPair: owner, writerKey: WRITER_B, baseKey: BASE_KEY, sequence: 2, createdAt: 2000 })

    const { roster } = rosterFrom([bootstrap, addB])
    const byKey = Object.fromEntries(roster.writers.map((w) => [w.writerKey, w]))
    assert.equal(byKey[OWNER_WRITER].joinedAt, 1000)
    assert.equal(byKey[OWNER_WRITER].isOwner, true)
    assert.equal(byKey[WRITER_B].joinedAt, 2000)
    assert.equal(byKey[WRITER_B].isOwner, false)
})

test('reduceMembershipLog rebuilds writerCreatedAt so join dates survive a restart', () => {
    const owner = createOwnerAuthorityKeyPair()
    const records = [
        createOwnerBootstrapRecord({ ownerAuthorityKeyPair: owner, writerKey: OWNER_WRITER, baseKey: BASE_KEY, createdAt: 1000 }),
        createAddWriterMembershipRecord({ ownerAuthorityKeyPair: owner, writerKey: WRITER_B, baseKey: BASE_KEY, sequence: 2, createdAt: 2000 }),
    ]
    // Fresh replay from the durable log (the restart path) must reproduce the dates.
    const state = reduceMembershipLog(records, { baseKey: BASE_KEY })
    assert.equal(state.writerCreatedAt.get(OWNER_WRITER), 1000)
    assert.equal(state.writerCreatedAt.get(WRITER_B), 2000)
})

test('first join wins: a re-add keeps the earliest authorization date', () => {
    const owner = createOwnerAuthorityKeyPair()
    const records = [
        createOwnerBootstrapRecord({ ownerAuthorityKeyPair: owner, writerKey: OWNER_WRITER, baseKey: BASE_KEY, createdAt: 1000 }),
        createAddWriterMembershipRecord({ ownerAuthorityKeyPair: owner, writerKey: WRITER_B, baseKey: BASE_KEY, sequence: 2, createdAt: 2000 }),
        // A later, higher-sequence re-add of the same writer must NOT move its date.
        createAddWriterMembershipRecord({ ownerAuthorityKeyPair: owner, writerKey: WRITER_B, baseKey: BASE_KEY, sequence: 3, createdAt: 9000 }),
    ]
    const { roster } = rosterFrom(records)
    const b = roster.writers.find((w) => w.writerKey === WRITER_B)
    assert.equal(b.joinedAt, 2000)
})

test('joinedAt is null for a writer set with no recorded date (old-base tolerance)', () => {
    // A hand-built state missing writerCreatedAt (as an older reducer produced)
    // must not throw and must report joinedAt: null.
    const state = { writers: new Set([OWNER_WRITER]), ownerWriterKey: OWNER_WRITER }
    const roster = buildMembershipRoster(state, { localWriterKey: OWNER_WRITER, writable: true, hasOwnerAuthority: true })
    assert.equal(roster.writers[0].joinedAt, null)
})
