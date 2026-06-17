import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceController, resolveListByName } from './voice-controller.mjs'

const REGISTRY = [
    { id: 'groc1', listId: '__registry__', listType: 'registry', regKind: 'list', regName: 'Groceries', regType: 'shopping', updatedAt: 1 },
    { id: 'work1', listId: '__registry__', listType: 'registry', regKind: 'list', regName: 'Work Board', regType: 'kanban', updatedAt: 1 },
]

const CONTENT = [
    { id: 'i1', listId: 'groc1', listType: 'shopping', text: 'milk' },
    { id: 'i2', listId: 'default', listType: 'shopping', text: 'milk' },
    { id: 'i3', listId: 'work1', listType: 'kanban', text: 'milk run ticket' },
    { id: 'i4', listId: 'groc1', listType: 'shopping', text: 'bread' },
]

function makeController (overrides = {}) {
    const calls = { add: [], del: [] }
    const ctl = createVoiceController({
        addItem: async (text, listId, listType, extra) => { calls.add.push({ text, listId, listType, extra }); return true },
        deleteItem: async (item) => { calls.del.push(item); return true },
        getAllItems: async () => CONTENT,
        getRegistryItems: async () => REGISTRY,
        notesListId: 'notes1',
        ...overrides,
    })
    return { ctl, calls }
}

test('resolveListByName matches case- and accent-insensitively', () => {
    assert.deepEqual(resolveListByName('groceries', REGISTRY), { id: 'groc1', type: 'shopping' })
    assert.equal(resolveListByName('nonexistent', REGISTRY), null)
})

test('add_item to a named list resolves the listId and writes', async () => {
    const { ctl, calls } = makeController()
    const r = await ctl.execute({ intent: 'add_item', slots: { item: 'eggs', list: 'Groceries' } })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'added')
    assert.deepEqual(calls.add[0], { text: 'eggs', listId: 'groc1', listType: 'shopping', extra: undefined })
})

test('add_item to an unknown list does not write', async () => {
    const { ctl, calls } = makeController()
    const r = await ctl.execute({ intent: 'add_item', slots: { item: 'eggs', list: 'Pantry' } })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'listNotFound')
    assert.equal(calls.add.length, 0)
})

test('add_item without a list writes to the default list', async () => {
    const { ctl, calls } = makeController()
    const r = await ctl.execute({ intent: 'add_item', slots: { item: 'eggs', list: null } })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'addedDefault')
    assert.equal(calls.add[0].listId, 'default')
})

test('remove_item deletes exact matches across ALL lists', async () => {
    const { ctl, calls } = makeController()
    const r = await ctl.execute({ intent: 'remove_item', slots: { item: 'milk' } })
    assert.equal(r.ok, true)
    assert.equal(r.detail.count, 2) // i1 (groceries) + i2 (default)
    const deletedIds = calls.del.map((it) => it.id).sort()
    assert.deepEqual(deletedIds, ['i1', 'i2'])
})

test('remove_item never deletes a board ticket (protected)', async () => {
    const { ctl, calls } = makeController()
    await ctl.execute({ intent: 'remove_item', slots: { item: 'milk run ticket' } })
    // "milk run ticket" lives only on a kanban board → protected → no delete
    assert.equal(calls.del.length, 0)
})

test('remove_item with no match reports nothingToRemove', async () => {
    const { ctl, calls } = makeController()
    const r = await ctl.execute({ intent: 'remove_item', slots: { item: 'plutonium' } })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'nothingToRemove')
    assert.equal(calls.del.length, 0)
})

test('remove_item ambiguous fuzzy match is a no-op', async () => {
    // "mil" fuzzy-matches both milk items but no exact → ambiguous, nothing removed
    const { ctl, calls } = makeController()
    const r = await ctl.execute({ intent: 'remove_item', slots: { item: 'mil' } })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'ambiguous')
    assert.equal(calls.del.length, 0)
})

test('note writes to the notes list with the notes type', async () => {
    const { ctl, calls } = makeController()
    const r = await ctl.execute({ intent: 'note', slots: { text: 'call the plumber' } })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'noteSaved')
    assert.deepEqual(
        { text: calls.add[0].text, listId: calls.add[0].listId, listType: calls.add[0].listType },
        { text: 'call the plumber', listId: 'notes1', listType: 'notes' },
    )
})

test('note with no notes list configured is unavailable', async () => {
    const { ctl } = makeController({ notesListId: null })
    const r = await ctl.execute({ intent: 'note', slots: { text: 'hi' } })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'notesUnavailable')
})

test('unknown intent returns unknownCommand', async () => {
    const { ctl } = makeController()
    const r = await ctl.execute({ intent: 'unknown', slots: {} })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'unknownCommand')
})
