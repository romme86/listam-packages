import test from 'node:test'
import assert from 'node:assert/strict'
import { keyPair } from 'hypercore-crypto'
import {
    createBoardConfigState,
    createBoardConfigRecord,
    reduceBoardConfigOperation,
    reduceBoardConfigLog,
    isBoardConfigRecord,
    nextBoardConfigSequence,
} from './lib/board-config.mjs'
import { DEFAULT_BOARD_CONFIG } from './lib/board.mjs'

const BASE_KEY = 'ab'.repeat(32) // 32 bytes

function owner () { return keyPair() }
function pub (kp) { return Buffer.from(kp.publicKey).toString('hex') }

test('default board-config state has rigor ON', () => {
    const state = createBoardConfigState()
    assert.equal(state.config.rigorOn, true)
    assert.equal(state.highestSequence, 0)
})

test('a valid creator record flips rigor off', () => {
    const kp = owner()
    const rec = createBoardConfigRecord({
        ownerAuthorityKeyPair: kp, baseKey: BASE_KEY,
        config: { ...DEFAULT_BOARD_CONFIG, rigorOn: false }, sequence: 1, createdAt: 1000,
    })
    assert.equal(isBoardConfigRecord(rec), true)
    const res = reduceBoardConfigOperation(rec, createBoardConfigState(), { baseKey: BASE_KEY, ownerAuthorityKey: pub(kp) })
    assert.equal(res.ok, true)
    assert.equal(res.state.config.rigorOn, false)
    assert.equal(res.state.highestSequence, 1)
})

test('a non-creator signature is rejected as wrong-owner', () => {
    const creator = owner()
    const attacker = owner()
    const rec = createBoardConfigRecord({
        ownerAuthorityKeyPair: attacker, baseKey: BASE_KEY,
        config: { ...DEFAULT_BOARD_CONFIG, rigorOn: false }, sequence: 1, createdAt: 1000,
    })
    const res = reduceBoardConfigOperation(rec, createBoardConfigState(), { baseKey: BASE_KEY, ownerAuthorityKey: pub(creator) })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'wrong-owner')
    assert.equal(res.state.config.rigorOn, true) // unchanged
})

test('a tampered signature is rejected', () => {
    const kp = owner()
    const rec = createBoardConfigRecord({
        ownerAuthorityKeyPair: kp, baseKey: BASE_KEY,
        config: { ...DEFAULT_BOARD_CONFIG, rigorOn: false }, sequence: 1, createdAt: 1000,
    })
    const tampered = { ...rec, signature: rec.signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) }
    const res = reduceBoardConfigOperation(tampered, createBoardConfigState(), { baseKey: BASE_KEY, ownerAuthorityKey: pub(kp) })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'bad-signature')
})

test('a record bound to a different base is rejected', () => {
    const kp = owner()
    const rec = createBoardConfigRecord({
        ownerAuthorityKeyPair: kp, baseKey: BASE_KEY,
        config: DEFAULT_BOARD_CONFIG, sequence: 1, createdAt: 1000,
    })
    const res = reduceBoardConfigOperation(rec, createBoardConfigState(), { baseKey: 'cd'.repeat(32), ownerAuthorityKey: pub(kp) })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'wrong-base')
})

test('a replayed sequence is rejected', () => {
    const kp = owner()
    let state = createBoardConfigState()
    const r1 = createBoardConfigRecord({
        ownerAuthorityKeyPair: kp, baseKey: BASE_KEY,
        config: { ...DEFAULT_BOARD_CONFIG, rigorOn: false }, sequence: 1, createdAt: 1000,
    })
    state = reduceBoardConfigOperation(r1, state, { baseKey: BASE_KEY, ownerAuthorityKey: pub(kp) }).state
    const replay = reduceBoardConfigOperation(r1, state, { baseKey: BASE_KEY, ownerAuthorityKey: pub(kp) })
    assert.equal(replay.ok, false)
    assert.equal(replay.reason, 'replay')
})

test('reduceBoardConfigLog rebuilds state across a record sequence', () => {
    const kp = owner()
    const r1 = createBoardConfigRecord({
        ownerAuthorityKeyPair: kp, baseKey: BASE_KEY,
        config: { ...DEFAULT_BOARD_CONFIG, rigorOn: false }, sequence: 1, createdAt: 1000,
    })
    const r2 = createBoardConfigRecord({
        ownerAuthorityKeyPair: kp, baseKey: BASE_KEY,
        config: { ...DEFAULT_BOARD_CONFIG, rigorOn: true }, sequence: 2, createdAt: 2000,
    })
    const state = reduceBoardConfigLog([r1, r2], { baseKey: BASE_KEY, ownerAuthorityKey: pub(kp) })
    assert.equal(state.config.rigorOn, true)
    assert.equal(state.highestSequence, 2)
    assert.equal(nextBoardConfigSequence(state), 3)
})
