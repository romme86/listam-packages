import test from 'node:test'
import assert from 'node:assert/strict'
import {
    UNGROUPED_GROUP_ID,
    toNavLibrary,
    flatten,
    locate,
    step,
    nextList,
    prevList,
    crossesGroupBoundary,
    resolveLaunchList,
} from './list-nav.mjs'

// Workspace[a,b] · Trips[c]
const registry = {
    groups: [
        { id: 'g1', name: 'Workspace', order: 0 },
        { id: 'g2', name: 'Trips', order: 1 },
    ],
    lists: [
        { id: 'a', name: 'Apples', type: 'shopping', groupId: 'g1', order: 0 },
        { id: 'b', name: 'Boards', type: 'board', groupId: 'g1', order: 1 },
        { id: 'c', name: 'Japan', type: 'board', groupId: 'g2', order: 0 },
    ],
}

function lib (defaultListId = null, extraLists = []) {
    return toNavLibrary(registry, { defaultListId, extraLists })
}

test('toNavLibrary orders groups + lists and files unfiled into Ungrouped last', () => {
    const l = toNavLibrary(registry, { extraLists: [{ id: 'z', name: 'Loose', type: 'shopping' }] })
    assert.deepEqual(l.groups.map((g) => g.id), ['g1', 'g2', UNGROUPED_GROUP_ID])
    assert.deepEqual(l.groups[0].listIds, ['a', 'b'])
    assert.deepEqual(l.groups[1].listIds, ['c'])
    assert.deepEqual(l.groups[2].listIds, ['z'])
})

test('flatten + locate report position within the group', () => {
    const l = lib()
    assert.deepEqual(flatten(l).map((e) => e.listId), ['a', 'b', 'c'])
    const pos = locate(l, 'b')
    assert.equal(pos.groupId, 'g1')
    assert.equal(pos.indexInGroup, 1)
    assert.equal(pos.groupSize, 2)
    assert.equal(pos.groupCount, 2)
})

test('step moves within a group without crossing', () => {
    const move = nextList(lib(), 'a')
    assert.equal(move.listId, 'b')
    assert.equal(move.crossedGroup, false)
})

test('stepping past the last list of a group crosses into the next, with the new group name', () => {
    const move = nextList(lib(), 'b')
    assert.equal(move.listId, 'c')
    assert.equal(move.crossedGroup, true)
    assert.equal(move.toGroupName, 'Trips')
    const boundary = crossesGroupBoundary(lib(), 'b', 1)
    assert.equal(boundary.crosses, true)
    assert.equal(boundary.toGroupName, 'Trips')
})

test('no wrap by default at the library edges', () => {
    assert.equal(nextList(lib(), 'c').listId, null) // last list, no next
    assert.equal(prevList(lib(), 'a').listId, null) // first list, no prev
    // opt-in wrap
    assert.equal(nextList(lib(), 'c', { wrap: true }).listId, 'a')
    assert.equal(nextList(lib(), 'c', { wrap: true }).wrapped, true)
})

test('jumpGroup lands on the first list of the adjacent group', () => {
    const move = step(lib(), 'a', 1, { jumpGroup: true })
    assert.equal(move.listId, 'c') // first of Trips, skipping b
    assert.equal(move.crossedGroup, true)
    assert.equal(move.toGroupName, 'Trips')
    // no next group from the last group, no wrap
    assert.equal(step(lib(), 'c', 1, { jumpGroup: true }).listId, null)
})

test('resolveLaunchList prefers a valid default, else first list, ignoring stale defaults', () => {
    assert.equal(resolveLaunchList(lib('b')), 'b')
    assert.equal(resolveLaunchList(lib('nonexistent')), 'a') // stale default → first
    assert.equal(resolveLaunchList(lib()), 'a')
    // validIds filter: default 'a' not yet synced → skip to first valid
    assert.equal(resolveLaunchList(lib('a'), new Set(['b', 'c'])), 'b')
})

test('single group + single list edge cases', () => {
    const solo = toNavLibrary({ groups: [{ id: 'g', name: 'Only', order: 0 }], lists: [{ id: 'only', name: 'One', type: 'shopping', groupId: 'g', order: 0 }] })
    assert.equal(nextList(solo, 'only').listId, null)
    assert.equal(prevList(solo, 'only').listId, null)
    assert.equal(locate(solo, 'only').groupSize, 1)
})
