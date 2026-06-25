import test from 'node:test'
import assert from 'node:assert/strict'
import {
    isSharedCredItem,
    isSharedJoinReqItem,
    isInternalChannelItem,
    buildSharedCredItem,
    reduceSharedCreds,
    buildSharedJoinReqItem,
    reduceSharedJoinReqs,
    SHARED_CREDS_LIST_TYPE,
    SHARED_JOINREQ_LIST_TYPE,
} from './shared-creds.mjs'

const HEX = (n) => 'a'.repeat(n)

test('cred items: build + classify + LWW reduce', () => {
    const item = buildSharedCredItem({ baseKey: HEX(64), encKey: HEX(64), epochKey: HEX(64), updatedAt: 5 })
    assert.equal(item.listType, SHARED_CREDS_LIST_TYPE)
    assert.equal(item.id, HEX(64))
    assert.equal(isSharedCredItem(item), true)
    assert.equal(isInternalChannelItem(item), true)
    assert.equal(isSharedCredItem({ listType: 'shopping' }), false)
    // base item shape so it survives the item pipeline / validateItem
    assert.equal(item.text, '')
    assert.equal(item.isDone, false)
    assert.equal(item.timeOfCompletion, 0)

    // LWW by updatedAt; bad hex is dropped to null.
    const older = buildSharedCredItem({ baseKey: HEX(64), encKey: HEX(64), epochKey: 'NOTHEX', updatedAt: 1 })
    const reduced = reduceSharedCreds([older, item])
    assert.equal(reduced.size, 1)
    const creds = reduced.get(HEX(64))
    assert.equal(creds.encKey, HEX(64))
    assert.equal(creds.epochKey, HEX(64)) // the newer (updatedAt 5) wins
})

test('join-request items: build + classify + dedup by (base,writer)', () => {
    const req = buildSharedJoinReqItem({ baseKey: HEX(64), writerKey: HEX(64), epochPublicKey: HEX(64), updatedAt: 1 })
    assert.equal(req.listType, SHARED_JOINREQ_LIST_TYPE)
    assert.equal(req.id, `${HEX(64)}:${HEX(64)}`)
    assert.equal(isSharedJoinReqItem(req), true)
    assert.equal(isInternalChannelItem(req), true)

    const other = buildSharedJoinReqItem({ baseKey: HEX(64), writerKey: 'b'.repeat(64), updatedAt: 2 })
    const reqs = reduceSharedJoinReqs([req, other, req])
    assert.equal(reqs.length, 2)
    assert.ok(reqs.some((r) => r.writerKey === HEX(64) && r.baseKey === HEX(64)))
    assert.ok(reqs.some((r) => r.writerKey === 'b'.repeat(64)))
})

test('reduce ignores non-channel items', () => {
    const mix = [{ listType: 'registry', id: 'x' }, { listType: 'shopping', id: 'y' }, null]
    assert.equal(reduceSharedCreds(mix).size, 0)
    assert.equal(reduceSharedJoinReqs(mix).length, 0)
})
