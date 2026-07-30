import test from 'node:test'
import assert from 'node:assert/strict'
import {
    PRESENCE_LIST_ID,
    PRESENCE_LIST_TYPE,
    PRESENCE_HEARTBEAT_MS,
    PRESENCE_ONLINE_THRESHOLD_MS,
    COMPACTION_CAPABILITY,
    compactionReadiness,
    isPresenceItem,
    buildAttestedPresenceItem,
    buildPresenceItem,
    reducePresence,
    isOnlineNow,
    averageOnlineMs,
} from './presence.mjs'
import { normalizeListItem } from './list-reducer.mjs'
import { isRegistryItem } from './list-registry.mjs'
import { isLabelItem, isPeerLabelItem, reducePeerLabels } from './labels.mjs'

test('buildPresenceItem produces a well-shaped, validator-safe item', () => {
    const it = buildPresenceItem({
        writerKey: 'ab12',
        lastActiveAt: 1000,
        lastInteractionAt: 900,
        sessionStartedAt: 500,
        cumulativeOnlineMs: 60_000,
        sessionCount: 3,
    })
    assert.equal(it.id, 'ab12')
    assert.equal(it.writerKey, 'ab12')
    assert.equal(it.listId, PRESENCE_LIST_ID)
    assert.equal(it.listType, PRESENCE_LIST_TYPE)
    // Full base item shape so an old peer's normalizeListItem accepts it.
    assert.equal(it.text, '')
    assert.equal(it.isDone, false)
    assert.equal(it.timeOfCompletion, 0)
    // updatedAt defaults to lastActiveAt so a plain heartbeat monotonically wins.
    assert.equal(it.updatedAt, 1000)
    assert.equal(it.lastActiveAt, 1000)
    assert.equal(it.lastInteractionAt, 900)
    assert.equal(it.sessionStartedAt, 500)
    assert.equal(it.cumulativeOnlineMs, 60_000)
    assert.equal(it.sessionCount, 3)
    assert.equal(it.attestedBy, null)
})

test('a presence item survives the strict list-item validator (old-peer safe)', () => {
    const it = buildPresenceItem({ writerKey: 'cd34', lastActiveAt: 5, cumulativeOnlineMs: 7, sessionCount: 2 })
    const normalized = normalizeListItem(it)
    assert.notEqual(normalized, null)
    // The numeric presence extras survive normalization (like labels' labelName).
    assert.equal(normalized.lastActiveAt, 5)
    assert.equal(normalized.cumulativeOnlineMs, 7)
    assert.equal(normalized.sessionCount, 2)
    assert.equal(normalized.listType, PRESENCE_LIST_TYPE)
})

test('owner attestation gives a legacy writer last-seen without discarding prior accounting', () => {
    const prior = {
        writerKey: 'legacy',
        lastActiveAt: 100,
        lastInteractionAt: 90,
        sessionStartedAt: 50,
        cumulativeOnlineMs: 400,
        sessionCount: 2,
        updatedAt: 100,
        attestedBy: 'owner',
    }
    const it = buildAttestedPresenceItem({
        writerKey: 'legacy',
        observedAt: 300,
        attestedBy: 'owner',
        existing: prior,
    })
    assert.equal(it.lastActiveAt, 300)
    assert.equal(it.lastInteractionAt, 300)
    assert.equal(it.updatedAt, 300)
    assert.equal(it.sessionStartedAt, 50)
    assert.equal(it.cumulativeOnlineMs, 400)
    assert.equal(it.sessionCount, 2)
    assert.equal(it.attestedBy, 'owner')
    assert.notEqual(normalizeListItem(it), null)
})

test('presence predicates: is a label-skip but not a peer-label or registry item', () => {
    const it = buildPresenceItem({ writerKey: 'ef56', lastActiveAt: 1 })
    assert.equal(isPresenceItem(it), true)
    // Folded into isLabelItem so every projection/nav gate hides it.
    assert.equal(isLabelItem(it), true)
    // But it is NOT a peer-label and NOT a registry item.
    assert.equal(isPeerLabelItem(it), false)
    assert.equal(isRegistryItem(it), false)
})

test('reducePresence keeps the newest updatedAt per writer key', () => {
    const items = [
        buildPresenceItem({ writerKey: 'k1', lastActiveAt: 100, cumulativeOnlineMs: 10, sessionCount: 1 }),
        buildPresenceItem({ writerKey: 'k1', lastActiveAt: 300, cumulativeOnlineMs: 30, sessionCount: 2 }),
        buildPresenceItem({ writerKey: 'k1', lastActiveAt: 200, cumulativeOnlineMs: 20, sessionCount: 1 }),
        buildPresenceItem({ writerKey: 'k2', lastActiveAt: 50, cumulativeOnlineMs: 5, sessionCount: 1 }),
    ]
    const map = reducePresence(items)
    assert.equal(map.size, 2)
    assert.equal(map.get('k1').lastActiveAt, 300)
    assert.equal(map.get('k1').cumulativeOnlineMs, 30)
    assert.equal(map.get('k1').sessionCount, 2)
    assert.equal(map.get('k2').lastActiveAt, 50)
})

test('reducePresence tolerates malformed / empty / non-presence input', () => {
    assert.equal(reducePresence(null).size, 0)
    assert.equal(reducePresence(undefined).size, 0)
    assert.equal(reducePresence('nope').size, 0)
    const map = reducePresence([
        null,
        { listType: 'shopping', id: 'x' },
        buildPeerLabelItemLike('peerkey'),
        buildPresenceItem({ writerKey: 'ok', lastActiveAt: 9 }),
    ])
    assert.equal(map.size, 1)
    assert.equal(map.has('ok'), true)
})

test('isOnlineNow decays with the threshold', () => {
    const now = 1_000_000
    const fresh = { lastActiveAt: now - 10_000 }
    const stale = { lastActiveAt: now - (PRESENCE_ONLINE_THRESHOLD_MS + 1) }
    assert.equal(isOnlineNow(fresh, now), true)
    assert.equal(isOnlineNow(stale, now), false)
    // Exactly at the threshold counts as offline (strictly-less-than).
    assert.equal(isOnlineNow({ lastActiveAt: now - PRESENCE_ONLINE_THRESHOLD_MS }, now), false)
    // Unknown / never-seen is never online.
    assert.equal(isOnlineNow({ lastActiveAt: 0 }, now), false)
    assert.equal(isOnlineNow(null, now), false)
})

test('averageOnlineMs = cumulative / sessions, 0 when unknown', () => {
    assert.equal(averageOnlineMs({ cumulativeOnlineMs: 90_000, sessionCount: 3 }), 30_000)
    assert.equal(averageOnlineMs({ cumulativeOnlineMs: 90_000, sessionCount: 0 }), 0)
    assert.equal(averageOnlineMs(null), 0)
})

test('cadence + threshold constants are coherent (threshold safely exceeds cadence)', () => {
    assert.ok(PRESENCE_HEARTBEAT_MS > 0)
    assert.ok(PRESENCE_ONLINE_THRESHOLD_MS >= PRESENCE_HEARTBEAT_MS * 2)
})

// A minimal peer-label-shaped item (avoids importing buildPeerLabelItem just for
// one negative case): the reducer must ignore it because its listType differs.
function buildPeerLabelItemLike (writerKey) {
    return { id: writerKey, listId: '__peers__', listType: 'peer', text: 'name', isDone: false, timeOfCompletion: 0, updatedAt: 1, labelName: 'name' }
}

test('compactionReadiness: every writer self-reporting support is ready', () => {
    const items = [
        buildPresenceItem({ writerKey: 'aa', lastActiveAt: 10, compaction: COMPACTION_CAPABILITY }),
        buildPresenceItem({ writerKey: 'bb', lastActiveAt: 20, compaction: COMPACTION_CAPABILITY }),
    ]
    const readiness = compactionReadiness(reducePresence(items), ['aa', 'bb'])
    assert.equal(readiness.ready, true)
    assert.equal(readiness.readyCount, 2)
    assert.deepEqual(readiness.blockers, [])
})

test('compactionReadiness: a writer on an older build blocks the flatten', () => {
    // The 2026-07-28 near-fork in one assertion: the mesh looked ready by note,
    // and one peer was not.
    const items = [
        buildPresenceItem({ writerKey: 'aa', lastActiveAt: 10, compaction: COMPACTION_CAPABILITY }),
        buildPresenceItem({ writerKey: 'bb', lastActiveAt: 20 }),
    ]
    const readiness = compactionReadiness(reducePresence(items), ['aa', 'bb'])
    assert.equal(readiness.ready, false)
    assert.equal(readiness.readyCount, 1)
    assert.deepEqual(readiness.blockers, [{ writerKey: 'bb', reason: 'outdated' }])
})

test('compactionReadiness: a writer that never published presence blocks it', () => {
    const items = [buildPresenceItem({ writerKey: 'aa', lastActiveAt: 10, compaction: COMPACTION_CAPABILITY })]
    const readiness = compactionReadiness(reducePresence(items), ['aa', 'zz'])
    assert.equal(readiness.ready, false)
    assert.deepEqual(readiness.blockers, [{ writerKey: 'zz', reason: 'no-presence' }])
})

test('compactionReadiness: an owner-attested entry is never evidence of capability', () => {
    // Attested entries exist precisely for devices too old to publish their own
    // heartbeat, so the owner must not be able to vouch for support on their behalf.
    const items = [
        buildPresenceItem({ writerKey: 'aa', lastActiveAt: 10, compaction: COMPACTION_CAPABILITY }),
        buildAttestedPresenceItem({ writerKey: 'bb', observedAt: 20, attestedBy: 'aa' }),
    ]
    const readiness = compactionReadiness(reducePresence(items), ['aa', 'bb'])
    assert.equal(readiness.ready, false)
    assert.deepEqual(readiness.blockers, [{ writerKey: 'bb', reason: 'attested' }])
})

test('compactionReadiness: an empty writer set is not readiness', () => {
    assert.equal(compactionReadiness(new Map(), []).ready, false)
})

test('compactionReadiness: THIS device counts as ready without a heartbeat of its own', () => {
    // The bug this pins: desktop runs with `presenceWrites: false`, so it never
    // publishes a presence item — and it was therefore counted as a blocker
    // against its OWN flatten, forever. The owner's button could never enable, no
    // matter how up to date every other device was. Capability of the build you
    // are running inside is known, not observed.
    const items = [buildPresenceItem({ writerKey: 'bb', lastActiveAt: 20, compaction: COMPACTION_CAPABILITY })]
    const readiness = compactionReadiness(reducePresence(items), ['aa', 'bb'], { localWriterKey: 'aa' })
    assert.equal(readiness.ready, true)
    assert.equal(readiness.readyCount, 2)
    assert.deepEqual(readiness.blockers, [])
})

test('compactionReadiness: knowing THIS device does not vouch for any other', () => {
    // The whole point of the gate survives: only the local key is exempt.
    const readiness = compactionReadiness(new Map(), ['aa', 'bb'], { localWriterKey: 'aa' })
    assert.equal(readiness.ready, false)
    assert.deepEqual(readiness.blockers, [{ writerKey: 'bb', reason: 'no-presence' }])
    assert.equal(readiness.readyCount, 1)
})

test('compactionReadiness: a local key that is not a writer changes nothing', () => {
    // Pre-join, or a stale key after a base switch: the exemption must not invent
    // readiness for a device the roster does not list.
    const readiness = compactionReadiness(new Map(), ['aa'], { localWriterKey: 'zz' })
    assert.equal(readiness.total, 1)
    assert.deepEqual(readiness.blockers, [{ writerKey: 'aa', reason: 'no-presence' }])
})

test('compactionReadiness: the bare-number `required` form still works', () => {
    // One in-tree caller passed no options at all, but the signature was public.
    const items = [buildPresenceItem({ writerKey: 'aa', lastActiveAt: 10, compaction: 1 })]
    assert.equal(compactionReadiness(reducePresence(items), ['aa'], 1).ready, true)
    assert.deepEqual(
        compactionReadiness(reducePresence(items), ['aa'], 2).blockers,
        [{ writerKey: 'aa', reason: 'outdated' }],
        'a raised requirement must still re-gate every peer',
    )
})

test('compactionReadiness: a raised requirement re-gates THIS device too', () => {
    // Bumping COMPACTION_CAPABILITY is how a wire change is rolled out. The local
    // exemption says "I am this build" — not "I satisfy any future requirement".
    const readiness = compactionReadiness(new Map(), ['aa'], {
        localWriterKey: 'aa',
        required: COMPACTION_CAPABILITY + 1,
    })
    assert.equal(readiness.ready, false)
    assert.deepEqual(readiness.blockers, [{ writerKey: 'aa', reason: 'no-presence' }])
})

test('an older peer publishing no capability field reduces to 0, not undefined', () => {
    const legacy = { id: 'aa', listId: PRESENCE_LIST_ID, listType: PRESENCE_LIST_TYPE, updatedAt: 5, lastActiveAt: 5 }
    assert.equal(reducePresence([legacy]).get('aa').compaction, 0)
})
