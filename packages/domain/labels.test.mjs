import test from 'node:test'
import assert from 'node:assert/strict'
import {
    PEER_LABEL_LIST_ID,
    PEER_LABEL_LIST_TYPE,
    SURFACE_LABEL_LIST_ID,
    SURFACE_LABEL_LIST_TYPE,
    BUILTIN_GROUP_LIST_ID,
    BUILTIN_GROUP_LIST_TYPE,
    VALUE_RETURN_LIST_ID,
    VALUE_RETURN_LIST_TYPE,
    isPeerLabelItem,
    isSurfaceLabelItem,
    isBuiltinGroupItem,
    isValueReturnItem,
    isLabelItem,
    surfaceLabelKey,
    buildPeerLabelItem,
    buildSurfaceLabelItem,
    buildBuiltinGroupItem,
    buildValueReturnItem,
    reducePeerLabels,
    reduceSurfaceLabels,
    reduceBuiltinGroups,
    reduceValueReturn,
    cleanLabelName,
} from './labels.mjs'
import { normalizeListItem } from './list-reducer.mjs'
import { isRegistryItem } from './list-registry.mjs'

test('buildPeerLabelItem produces a well-shaped, validator-safe item', () => {
    const it = buildPeerLabelItem({ writerKey: 'abc123', name: "Fabio's MacBook", updatedAt: 7 })
    assert.equal(it.id, 'abc123')
    assert.equal(it.writerKey, 'abc123')
    assert.equal(it.listId, PEER_LABEL_LIST_ID)
    assert.equal(it.listType, PEER_LABEL_LIST_TYPE)
    assert.equal(it.text, "Fabio's MacBook")
    assert.equal(it.labelName, "Fabio's MacBook")
    assert.equal(it.isDone, false)
    assert.equal(it.timeOfCompletion, 0)
    assert.equal(it.updatedAt, 7)
    assert.equal(isPeerLabelItem(it), true)
    assert.equal(isLabelItem(it), true)
    // Not mistaken for a registry item, and vice-versa.
    assert.equal(isRegistryItem(it), false)
})

test('label items survive the strict reducer normalizer (so old peers accept them)', () => {
    const peer = buildPeerLabelItem({ writerKey: 'k1', name: 'Pi', updatedAt: 1 })
    const surf = buildSurfaceLabelItem({ listId: 'default', type: 'shopping', name: 'Spesa', updatedAt: 1 })
    // normalizeListItem returns null for anything missing the base shape; a
    // non-null result means an older peer stores it instead of dropping it.
    assert.ok(normalizeListItem(peer))
    assert.ok(normalizeListItem(surf))
    assert.equal(normalizeListItem(peer).listId, PEER_LABEL_LIST_ID)
})

test('surfaceLabelKey is stable and id-forming', () => {
    assert.equal(surfaceLabelKey('default', 'shopping'), 'default:shopping')
    const it = buildSurfaceLabelItem({ listId: 'default', type: 'board', name: 'Bacheca', updatedAt: 2 })
    assert.equal(it.id, 'default:board')
    assert.equal(it.surfaceKey, 'default:board')
    assert.equal(it.listId, SURFACE_LABEL_LIST_ID)
    assert.equal(it.listType, SURFACE_LABEL_LIST_TYPE)
    assert.equal(isSurfaceLabelItem(it), true)
})

test('reducePeerLabels keeps newest by updatedAt', () => {
    const items = [
        buildPeerLabelItem({ writerKey: 'a', name: 'Old', updatedAt: 1 }),
        buildPeerLabelItem({ writerKey: 'a', name: 'New', updatedAt: 5 }),
        buildPeerLabelItem({ writerKey: 'b', name: 'Geekom', updatedAt: 3 }),
        { id: 'noise', text: 'milk', isDone: false, timeOfCompletion: 0, listType: 'shopping' },
    ]
    const map = reducePeerLabels(items)
    assert.equal(map.get('a'), 'New')
    assert.equal(map.get('b'), 'Geekom')
    assert.equal(map.size, 2)
})

test('an empty newest name clears the label (no tombstone needed)', () => {
    const items = [
        buildSurfaceLabelItem({ listId: 'default', type: 'todo', name: 'Cose', updatedAt: 1 }),
        buildSurfaceLabelItem({ listId: 'default', type: 'todo', name: '', updatedAt: 9 }),
    ]
    const map = reduceSurfaceLabels(items)
    assert.equal(map.has('default:todo'), false)
})

test('an older empty entry does not clear a newer name', () => {
    const items = [
        buildSurfaceLabelItem({ listId: 'default', type: 'todo', name: '', updatedAt: 9 }),
        buildSurfaceLabelItem({ listId: 'default', type: 'todo', name: 'Cose', updatedAt: 10 }),
    ]
    assert.equal(reduceSurfaceLabels(items).get('default:todo'), 'Cose')
})

test('cleanLabelName trims and caps at 64 chars', () => {
    assert.equal(cleanLabelName('  hi  '), 'hi')
    assert.equal(cleanLabelName('x'.repeat(100)).length, 64)
    assert.equal(cleanLabelName(42), '')
    assert.equal(cleanLabelName(undefined), '')
})

test('peer and surface buckets do not cross-read', () => {
    const items = [
        buildPeerLabelItem({ writerKey: 'k', name: 'Phone', updatedAt: 1 }),
        buildSurfaceLabelItem({ listId: 'default', type: 'shopping', name: 'Spesa', updatedAt: 1 }),
    ]
    assert.equal(reducePeerLabels(items).size, 1)
    assert.equal(reduceSurfaceLabels(items).size, 1)
    assert.equal(reducePeerLabels(items).get('k'), 'Phone')
    assert.equal(reduceSurfaceLabels(items).get('default:shopping'), 'Spesa')
})

test('buildBuiltinGroupItem parks the groupId and is validator-safe', () => {
    const it = buildBuiltinGroupItem({ listId: 'default', type: 'shopping', groupId: 'group-123-4', updatedAt: 3 })
    assert.equal(it.id, 'default:shopping')
    assert.equal(it.surfaceKey, 'default:shopping')
    assert.equal(it.listId, BUILTIN_GROUP_LIST_ID)
    assert.equal(it.listType, BUILTIN_GROUP_LIST_TYPE)
    // The groupId rides in text/labelName the way a name does.
    assert.equal(it.text, 'group-123-4')
    assert.equal(it.labelName, 'group-123-4')
    assert.equal(it.isDone, false)
    assert.equal(it.timeOfCompletion, 0)
    assert.equal(isBuiltinGroupItem(it), true)
    assert.equal(isLabelItem(it), true)
    // Not mistaken for a registry item, nor for the other label channels.
    assert.equal(isRegistryItem(it), false)
    assert.equal(isPeerLabelItem(it), false)
    assert.equal(isSurfaceLabelItem(it), false)
    // An older peer's strict normalizer stores it (does not drop it).
    assert.ok(normalizeListItem(it))
})

test('reduceBuiltinGroups keeps newest groupId by updatedAt, ignores noise', () => {
    const items = [
        buildBuiltinGroupItem({ listId: 'default', type: 'shopping', groupId: 'general', updatedAt: 1 }),
        buildBuiltinGroupItem({ listId: 'default', type: 'shopping', groupId: 'routine', updatedAt: 5 }),
        buildBuiltinGroupItem({ listId: 'default', type: 'todo', groupId: 'routine', updatedAt: 2 }),
        { id: 'noise', text: 'milk', isDone: false, timeOfCompletion: 0, listType: 'shopping' },
    ]
    const map = reduceBuiltinGroups(items)
    assert.equal(map.get('default:shopping'), 'routine')
    assert.equal(map.get('default:todo'), 'routine')
    assert.equal(map.size, 2)
})

test('an empty builtin-group value clears the placement (reverts to general)', () => {
    const items = [
        buildBuiltinGroupItem({ listId: 'default', type: 'board', groupId: 'routine', updatedAt: 1 }),
        buildBuiltinGroupItem({ listId: 'default', type: 'board', groupId: '', updatedAt: 9 }),
    ]
    assert.equal(reduceBuiltinGroups(items).has('default:board'), false)
})

test('the three label buckets stay isolated (no cross-read)', () => {
    const items = [
        buildPeerLabelItem({ writerKey: 'k', name: 'Phone', updatedAt: 1 }),
        buildSurfaceLabelItem({ listId: 'default', type: 'shopping', name: 'Spesa', updatedAt: 1 }),
        buildBuiltinGroupItem({ listId: 'default', type: 'shopping', groupId: 'routine', updatedAt: 1 }),
    ]
    assert.equal(reducePeerLabels(items).size, 1)
    assert.equal(reduceSurfaceLabels(items).size, 1)
    assert.equal(reduceBuiltinGroups(items).size, 1)
    assert.equal(reduceBuiltinGroups(items).get('default:shopping'), 'routine')
    // The rename and the group placement share a surfaceKey but live in
    // different buckets, so neither leaks into the other's reduce.
    assert.equal(reduceSurfaceLabels(items).get('default:shopping'), 'Spesa')
})

test('buildValueReturnItem is a validator-safe label item keyed by surface', () => {
    const it = buildValueReturnItem({ listId: 'default', type: 'board', enabled: true, updatedAt: 4 })
    assert.equal(it.id, 'default:board')
    assert.equal(it.surfaceKey, 'default:board')
    assert.equal(it.listId, VALUE_RETURN_LIST_ID)
    assert.equal(it.listType, VALUE_RETURN_LIST_TYPE)
    assert.equal(it.labelName, '1')
    assert.equal(isValueReturnItem(it), true)
    assert.equal(isLabelItem(it), true)
    assert.equal(isBuiltinGroupItem(it), false)
    assert.equal(isSurfaceLabelItem(it), false)
    assert.ok(normalizeListItem(it))
})

test('reduceValueReturn maps enabled surfaces; disable clears, newest wins', () => {
    const items = [
        buildValueReturnItem({ listId: 'default', type: 'board', enabled: true, updatedAt: 1 }),
        buildValueReturnItem({ listId: 'list-9', type: 'todo', enabled: true, updatedAt: 1 }),
        // toggled off later -> dropped from the map
        buildValueReturnItem({ listId: 'list-9', type: 'todo', enabled: false, updatedAt: 5 }),
        { id: 'noise', text: 'milk', isDone: false, timeOfCompletion: 0, listType: 'shopping' },
    ]
    const map = reduceValueReturn(items)
    assert.equal(map.get('default:board'), true)
    assert.equal(map.has('list-9:todo'), false)
    assert.equal(map.size, 1)
})
