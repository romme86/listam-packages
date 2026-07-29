import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createOwnerAuthorityKeyPair,
    createOwnerBootstrapRecord,
    createAddWriterMembershipRecord,
    reduceMembershipLog,
    buildMembershipRoster,
    createMembershipState,
    shouldAdoptBootMembership,
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

test('a stale boot membership snapshot never replaces a reduced live state', () => {
    // The 2026-07-29 Nothing Phone join: boot read the view of a freshly joined
    // base while it was still empty, init continued without waiting, and apply()
    // spent ~5 minutes reducing the real history into the live state. When the
    // boot read finally resolved it carried the EMPTY snapshot — installing it
    // wiped a complete roster and made the owner look absent.
    const owner = createOwnerAuthorityKeyPair()
    const live = reduceMembershipLog([
        createOwnerBootstrapRecord({
            ownerAuthorityKeyPair: owner, writerKey: OWNER_WRITER, baseKey: BASE_KEY, epoch: 1,
        }),
        createAddWriterMembershipRecord({
            ownerAuthorityKeyPair: owner, writerKey: WRITER_B, baseKey: BASE_KEY, sequence: 2,
        }),
    ], { baseKey: BASE_KEY })

    assert.ok(live.ownerAuthorityKey, 'precondition: the live state has an owner')
    assert.equal(shouldAdoptBootMembership(live, createMembershipState()), false)
})

test('a cold boot with no live state adopts the boot snapshot', () => {
    // The normal path this replay exists for: nothing has been reduced yet, so
    // whatever the view holds is strictly better than an empty live state.
    const owner = createOwnerAuthorityKeyPair()
    const boot = reduceMembershipLog([
        createOwnerBootstrapRecord({
            ownerAuthorityKeyPair: owner, writerKey: OWNER_WRITER, baseKey: BASE_KEY, epoch: 1,
        }),
    ], { baseKey: BASE_KEY })

    assert.equal(shouldAdoptBootMembership(createMembershipState(), boot), true)
})

test('a boot snapshot at or ahead of the live sequence is adopted', () => {
    // Boot reading MORE than apply has reduced is the case the replay is for;
    // equal sequences are the same state, so adopting is a no-op either way.
    const owner = createOwnerAuthorityKeyPair()
    const records = [
        createOwnerBootstrapRecord({
            ownerAuthorityKeyPair: owner, writerKey: OWNER_WRITER, baseKey: BASE_KEY, epoch: 1,
        }),
        createAddWriterMembershipRecord({
            ownerAuthorityKeyPair: owner, writerKey: WRITER_B, baseKey: BASE_KEY, sequence: 2,
        }),
    ]
    const live = reduceMembershipLog(records.slice(0, 1), { baseKey: BASE_KEY })
    const ahead = reduceMembershipLog(records, { baseKey: BASE_KEY })

    assert.equal(shouldAdoptBootMembership(live, ahead), true)
    assert.equal(shouldAdoptBootMembership(live, live), true)
})
