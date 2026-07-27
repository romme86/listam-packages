import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnnouncementLog, committedItemIds, retractionPayload } from './announce.mjs'

const row = (id, extra = {}) => ({ id, text: id, listId: 'default', listType: 'shopping', ...extra })

test('a retraction payload carries what a client needs to drop the row', () => {
    assert.deepEqual(retractionPayload(row('a')), { id: 'a', listId: 'default', listType: 'shopping' })
    // Bucketing fields are optional; the id is not.
    assert.deepEqual(retractionPayload({ id: 'b' }), { id: 'b', listId: null, listType: null })
    assert.equal(retractionPayload({ text: 'no id' }), null)
    assert.equal(retractionPayload(null), null)
})

test('an announced row that is not in the committed view is a phantom', () => {
    const log = createAnnouncementLog()
    log.note(row('kept'))
    log.note(row('dropped'))

    const phantoms = log.phantoms(committedItemIds([row('kept')]))
    assert.deepEqual(phantoms.map((p) => p.id), ['dropped'])
})

test('phantoms() is a pure read — the caller decides what to forget', () => {
    const log = createAnnouncementLog()
    log.note(row('dropped'))
    const committed = committedItemIds([])

    assert.equal(log.phantoms(committed).length, 1)
    assert.equal(log.phantoms(committed).length, 1, 'reading twice must not consume the entry')
    log.forget('dropped')
    assert.deepEqual(log.phantoms(committed), [])
})

test('a delete withdraws the assertion, so the row is no longer ours to retract', () => {
    const log = createAnnouncementLog()
    log.note(row('gone'))
    log.forget('gone')
    // The row is absent from the committed view, but WE told the frontend to
    // drop it — retracting again would be a duplicate delete.
    assert.deepEqual(log.phantoms(committedItemIds([])), [])
})

test('only rows this log announced can ever be retracted', () => {
    const log = createAnnouncementLog()
    log.note(row('mine'))
    // 'theirs' reached the frontend some other way (boot projection, SYNC_LIST)
    // and is absent from the view. It must not be retracted by this log.
    const phantoms = log.phantoms(committedItemIds([]))
    assert.deepEqual(phantoms.map((p) => p.id), ['mine'])
})

test('re-announcing a row keeps one entry, with the latest bucketing', () => {
    const log = createAnnouncementLog()
    log.note(row('a'))
    log.note(row('a', { listId: 'work', listType: 'board' }))
    assert.equal(log.size, 1)
    assert.deepEqual(log.phantoms(committedItemIds([])), [{ id: 'a', listId: 'work', listType: 'board' }])
})

test('committedItemIds ignores malformed entries instead of throwing', () => {
    const ids = committedItemIds([row('a'), null, { text: 'no id' }, { id: 7 }])
    assert.deepEqual([...ids], ['a'])
})

test('phantoms() refuses a non-Set argument rather than retracting everything', () => {
    const log = createAnnouncementLog()
    log.note(row('a'))
    // A caller that passed an array would otherwise see `has` be undefined and
    // retract the entire list.
    assert.deepEqual(log.phantoms(['a']), [])
    assert.deepEqual(log.phantoms(null), [])
})

test('clear drops everything', () => {
    const log = createAnnouncementLog()
    log.note(row('a'))
    log.note(row('b'))
    assert.equal(log.size, 2)
    log.clear()
    assert.equal(log.size, 0)
    assert.equal(log.has('a'), false)
})
