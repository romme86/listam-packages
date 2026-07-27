// rigorOnSince and the non-retroactive rule it exists for.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'hypercore-crypto'
import {
    createBoardConfigState,
    createBoardConfigRecord,
    reduceBoardConfigLog,
    rigorAppliesToItem,
} from './board-config.mjs'

const owner = crypto.keyPair()
const baseKey = crypto.randomBytes(32)

const record = (rigorOn, sequence, createdAt) => createBoardConfigRecord({
    ownerAuthorityKeyPair: owner,
    baseKey,
    config: { rigorOn },
    sequence,
    createdAt,
})

const reduce = (...records) => reduceBoardConfigLog(records, { baseKey, ownerAuthorityKey: owner.publicKey.toString('hex') })

test('the default config is rigor-on since the beginning', () => {
    const state = createBoardConfigState()
    assert.equal(state.config.rigorOn, true)
    assert.equal(state.rigorOnSince, 0, '0 means "always", so the gate applies to every ticket')
    assert.equal(rigorAppliesToItem({ timestamp: 1 }, state), true)
    assert.equal(rigorAppliesToItem({ timestamp: 0 }, state), true)
})

test('turning rigor off clears the boundary', () => {
    const state = reduce(record(false, 1, 1000))
    assert.equal(state.config.rigorOn, false)
    assert.equal(state.rigorOnSince, null)
    assert.equal(rigorAppliesToItem({ timestamp: 5000 }, state), false, 'rigor off gates nothing')
})

test('turning rigor back on records the transition, not the record', () => {
    const state = reduce(record(false, 1, 1000), record(true, 2, 2000))
    assert.equal(state.config.rigorOn, true)
    assert.equal(state.rigorOnSince, 2000)
})

test('a ticket written before the transition is not gated; one written after is', () => {
    const state = reduce(record(false, 1, 1000), record(true, 2, 2000))
    assert.equal(rigorAppliesToItem({ timestamp: 1999 }, state), false)
    assert.equal(rigorAppliesToItem({ timestamp: 2000 }, state), true, 'ties gate — the safe direction')
    assert.equal(rigorAppliesToItem({ timestamp: 2001 }, state), true)
})

test('a later config that leaves rigor on does NOT move the boundary', () => {
    // Otherwise editing an unrelated field would retroactively invalidate every
    // ticket written since rigor was turned on.
    const state = reduce(record(false, 1, 1000), record(true, 2, 2000), record(true, 3, 9000))
    assert.equal(state.rigorOnSince, 2000)
    assert.equal(rigorAppliesToItem({ timestamp: 3000 }, state), true)
})

test('off then on then off then on tracks the latest transition', () => {
    const state = reduce(
        record(false, 1, 1000),
        record(true, 2, 2000),
        record(false, 3, 3000),
        record(true, 4, 4000),
    )
    assert.equal(state.rigorOnSince, 4000)
    assert.equal(rigorAppliesToItem({ timestamp: 2500 }, state), false, 'written during the rigor-off window')
    assert.equal(rigorAppliesToItem({ timestamp: 4500 }, state), true)
})

test('updatedAt is the fallback for rows written before timestamp existed', () => {
    const state = reduce(record(false, 1, 1000), record(true, 2, 2000))
    assert.equal(rigorAppliesToItem({ updatedAt: 3000 }, state), true)
    assert.equal(rigorAppliesToItem({ updatedAt: 1500 }, state), false)
    // Neither stamp: 0, older than any transition, so an ancient row is not
    // retroactively invalidated.
    assert.equal(rigorAppliesToItem({}, state), false)
})

test('rigorAppliesToItem is false whenever rigor is off, whatever the stamps', () => {
    const state = reduce(record(false, 1, 1000))
    assert.equal(rigorAppliesToItem({ timestamp: Number.MAX_SAFE_INTEGER }, state), false)
})

test('rigorAppliesToItem tolerates missing state', () => {
    assert.equal(rigorAppliesToItem({ timestamp: 1 }, null), false)
    assert.equal(rigorAppliesToItem(null, createBoardConfigState()), true, 'default board gates an unknown item')
})
