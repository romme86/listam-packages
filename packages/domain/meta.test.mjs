import test from 'node:test'
import assert from 'node:assert/strict'
import {
    DURABLE_META_LIST_TYPES,
    META_LIST_TYPES,
    VOLATILE_META_LIST_TYPES,
    isExportableItem,
    isMetaItem,
    isUserItem,
    isVolatileMetaItem,
} from './meta.mjs'
import { DEFAULT_LIST_TYPE, TODO_LIST_TYPE } from './identity.mjs'
import { BOARD_LIST_TYPE, LEGACY_BOARD_LIST_TYPE } from './board.mjs'
import { PRESENCE_LIST_TYPE } from './presence.mjs'
import { PLAN_LIST_TYPE } from './plan.mjs'
import { REGISTRY_LIST_TYPE } from './list-registry.mjs'
import { isLabelItem } from './labels.mjs'

const item = (listType) => ({ id: 'x', text: 't', listId: 'l', listType })

test('user list types are never meta', () => {
    for (const listType of [DEFAULT_LIST_TYPE, TODO_LIST_TYPE, BOARD_LIST_TYPE, LEGACY_BOARD_LIST_TYPE]) {
        assert.equal(isMetaItem(item(listType)), false, listType)
        assert.equal(isUserItem(item(listType)), true, listType)
    }
})

test('every reserved bucket is meta', () => {
    for (const listType of META_LIST_TYPES) {
        assert.equal(isMetaItem(item(listType)), true, listType)
        assert.equal(isUserItem(item(listType)), false, listType)
    }
})

test('durable and volatile partition the reserved set with no overlap', () => {
    for (const listType of DURABLE_META_LIST_TYPES) {
        assert.equal(VOLATILE_META_LIST_TYPES.has(listType), false, `${listType} is in both sets`)
    }
    assert.equal(META_LIST_TYPES.size, DURABLE_META_LIST_TYPES.size + VOLATILE_META_LIST_TYPES.size)
})

test('presence is volatile and never exported; the registry and plan are', () => {
    assert.equal(isVolatileMetaItem(item(PRESENCE_LIST_TYPE)), true)
    assert.equal(isExportableItem(item(PRESENCE_LIST_TYPE)), false)

    // A backup that dropped these would lose list names and day assignments.
    assert.equal(isExportableItem(item(REGISTRY_LIST_TYPE)), true)
    assert.equal(isExportableItem(item(PLAN_LIST_TYPE)), true)
    assert.equal(isExportableItem(item(DEFAULT_LIST_TYPE)), true)
})

test('shared-base credentials are never exportable', () => {
    // They are filtered before reaching a frontend today; this asserts the
    // second line of defence so a change to the push path cannot leak keys
    // into a plaintext backup file.
    for (const listType of ['sharedcreds', 'sharedjoinreq']) {
        assert.equal(isMetaItem(item(listType)), true, listType)
        assert.equal(isExportableItem(item(listType)), false, listType)
    }
})

test('isMetaItem agrees with the pre-existing label predicate', () => {
    // isLabelItem already covered peer/surface/builtin-group/value-return and
    // presence. Every item it accepts must remain meta, or call sites that
    // switch to isMetaItem would start rendering records they used to skip.
    for (const listType of ['peer', 'surfacename', 'builtingroup', 'valuereturn', PRESENCE_LIST_TYPE]) {
        assert.equal(isLabelItem(item(listType)), true, `${listType} label`)
        assert.equal(isMetaItem(item(listType)), true, `${listType} meta`)
    }
})

test('malformed values are treated as user rows, matching the list reducer', () => {
    for (const value of [null, undefined, 0, '', 'presence', [], { id: 'x' }, { listType: 42 }]) {
        assert.equal(isMetaItem(value), false, JSON.stringify(value))
        assert.equal(isUserItem(value), true, JSON.stringify(value))
    }
})
