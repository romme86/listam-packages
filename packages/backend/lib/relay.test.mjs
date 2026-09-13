import test from 'node:test'
import assert from 'node:assert/strict'
import b4a from 'b4a'
import z32 from 'z32'

import {
    createRelayThrough,
    getRelayKeys,
    parseRelayKey,
    parseRelayKeys,
    relayFingerprints,
    relaySwarmOptions,
    setRelayKeys,
} from './relay.mjs'

const KEY_A = b4a.alloc(32, 1)
const KEY_B = b4a.alloc(32, 2)

test('parseRelayKey accepts z32 and hex, rejects everything else', () => {
    assert.ok(b4a.equals(parseRelayKey(z32.encode(KEY_A)), KEY_A))
    assert.ok(b4a.equals(parseRelayKey(b4a.toString(KEY_A, 'hex')), KEY_A))
    assert.ok(b4a.equals(parseRelayKey(KEY_A), KEY_A))

    assert.equal(parseRelayKey(''), null)
    assert.equal(parseRelayKey('not-a-key'), null)
    assert.equal(parseRelayKey(null), null)
    // A truncated key is the realistic typo, and it must not become a silently
    // unreachable relay.
    assert.equal(parseRelayKey(b4a.toString(KEY_A, 'hex').slice(0, 40)), null)
    assert.equal(parseRelayKey(b4a.alloc(31, 1)), null)
})

test('parseRelayKeys splits, dedupes, and reports rejects without throwing', () => {
    const encoded = z32.encode(KEY_A)
    const { keys, rejected } = parseRelayKeys(`${encoded}, ${encoded} nonsense ${z32.encode(KEY_B)}`)
    assert.equal(keys.length, 2, 'the duplicate collapses')
    assert.deepEqual(rejected, ['nonsense'])

    // A bad relay key must cost relaying, never boot.
    assert.deepEqual(parseRelayKeys(null), { keys: [], rejected: [] })
    assert.deepEqual(parseRelayKeys(''), { keys: [], rejected: [] })
    assert.deepEqual(parseRelayKeys(['nope']).keys, [])
})

test('createRelayThrough returns null when nothing is configured', () => {
    // This is the pre-remediation behaviour and must stay reachable: with no
    // relay, Hyperswarm is left exactly as it was.
    assert.equal(createRelayThrough([]), null)
    assert.equal(createRelayThrough(null), null)
})

test('createRelayThrough relays only when randomized or forced', () => {
    const relay = createRelayThrough([KEY_A])
    const direct = { dht: { randomized: false } }
    const carrier = { dht: { randomized: true } }

    // A normal network punches directly; relaying it would be slower and would
    // spend relay bandwidth for nothing.
    assert.equal(relay(false, direct), null)

    // Carrier NAT: hyperdht will refuse to punch at all, so relay.
    assert.ok(b4a.equals(relay(false, carrier), KEY_A))

    // Forced is hyperswarm escalating after a HOLEPUNCH_ABORTED, which is the
    // path that only exists because relayThrough is now non-null.
    assert.ok(b4a.equals(relay(true, direct), KEY_A))

    // A missing swarm must not be read as randomized.
    assert.equal(relay(false, undefined), null)
    assert.equal(relay(false, {}), null)
})

test('createRelayThrough reports engagement exactly once', () => {
    const seen = []
    const relay = createRelayThrough([KEY_A], { onEngage: (info) => seen.push(info) })
    const carrier = { dht: { randomized: true } }

    relay(false, carrier)
    relay(false, carrier)
    relay(true, carrier)

    assert.equal(seen.length, 1, 'logged per swarm, not per connection')
    assert.deepEqual(seen[0], { forced: false, randomized: true })
})

test('createRelayThrough survives a throwing onEngage', () => {
    const relay = createRelayThrough([KEY_A], {
        onEngage: () => { throw new Error('logging blew up') },
    })
    // Logging must never be able to break connect().
    assert.ok(b4a.equals(relay(true, {}), KEY_A))
})

test('createRelayThrough spreads across configured relays', () => {
    const relay = createRelayThrough([KEY_A, KEY_B])
    const carrier = { dht: { randomized: true } }
    const picked = new Set()
    for (let i = 0; i < 200; i++) picked.add(b4a.toString(relay(false, carrier), 'hex'))
    assert.equal(picked.size, 2, 'a single relay must not be a single point of failure')
})

test('a retry visits the alternate relay without affecting direct connections', () => {
    const select = createRelayThrough([KEY_A, KEY_B])
    const first = select(true, {})
    assert.equal(select(false, {}), null)
    assert.notDeepEqual(select(true, {}), first)
    assert.deepEqual(select(true, {}), first)
})

test('relaySwarmOptions carries bootstrap and relay independently', () => {
    setRelayKeys(null)
    assert.deepEqual(relaySwarmOptions(null), {})
    assert.deepEqual(relaySwarmOptions([{ host: '127.0.0.1', port: 1 }]), {
        bootstrap: [{ host: '127.0.0.1', port: 1 }],
    })

    setRelayKeys([z32.encode(KEY_A)])
    assert.equal(getRelayKeys().length, 1)
    const opts = relaySwarmOptions(null)
    assert.equal(typeof opts.relayThrough, 'function', 'hyperswarm resolves this per connection')
    assert.equal(opts.bootstrap, undefined)

    setRelayKeys(null)
    assert.equal(relaySwarmOptions(null).relayThrough, undefined)
})

test('relayFingerprints are short and non-secret', () => {
    assert.deepEqual(relayFingerprints([KEY_A]), ['01010101'])
    assert.deepEqual(relayFingerprints(null), [])
})
