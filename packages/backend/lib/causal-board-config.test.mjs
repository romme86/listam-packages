import test from 'node:test'
import assert from 'node:assert/strict'
import { keyPair } from 'hypercore-crypto'
import { createBoardConfigRecord } from './board-config.mjs'
import { resolveCausalBoardConfig } from './causal-board-config.mjs'

const owner = keyPair(), baseKey = Buffer.alloc(32, 9)
const writer = '11'.repeat(32), guest = '22'.repeat(32), relay = '33'.repeat(32)
const off = createBoardConfigRecord({ ownerAuthorityKeyPair: owner, baseKey, config: { rigorOn: false }, sequence: 1, createdAt: 1000 })
const on = createBoardConfigRecord({ ownerAuthorityKeyPair: owner, baseKey, config: { rigorOn: true }, sequence: 2, createdAt: 2000 })
const options = { records: [off, on], baseKey, ownerAuthorityKey: owner.publicKey }
const point = (key, length) => ({ key, length })

test('a transitive acknowledgement proves the older config, independent of current prefix', async () => {
    const history = new Map([
        [`${writer}:1`, { value: off, heads: [] }],
        [`${relay}:1`, { value: null, heads: [point(writer, 1)] }],
    ])
    const state = await resolveCausalBoardConfig({
        ...options, node: { from: { key: guest }, length: 1, heads: [point(relay, 1)] },
        readNode: async (key, length) => history.get(`${key}:${length}`),
    })
    assert.equal(state.config.rigorOn, false)
    assert.equal(state.highestSequence, 1)
})

test('rules in the causal past are enforced even if the latest node omits its own prior head', async () => {
    const history = new Map([
        [`${writer}:2`, { value: on, heads: [point(writer, 1)] }],
        [`${guest}:1`, { value: null, heads: [point(writer, 2)] }],
    ])
    const state = await resolveCausalBoardConfig({
        ...options, node: { from: { key: guest }, length: 2, heads: [] },
        readNode: async (key, length) => history.get(`${key}:${length}`),
    })
    assert.equal(state.config.rigorOn, true)
    assert.equal(state.highestSequence, 2)
})

test('an unavailable ancestor fails explicitly instead of choosing rules from arrival order', async () => {
    await assert.rejects(resolveCausalBoardConfig({
        ...options, node: { from: { key: guest }, length: 1, heads: [point(writer, 1)] },
        readNode: async () => null,
    }), { code: 'ERR_CAUSAL_HISTORY_UNAVAILABLE' })
})

test('copying an accepted signature onto a changed ancestor cannot invent causal knowledge', async () => {
    const forged = { ...off, config: { ...off.config, rigorOn: true } }
    const state = await resolveCausalBoardConfig({
        ...options, node: { from: { key: guest }, length: 1, heads: [point(writer, 1)] },
        readNode: async () => ({ value: forged, heads: [] }),
    })
    assert.equal(state.highestSequence, 0)
    assert.equal(state.config.rigorOn, true)
})
