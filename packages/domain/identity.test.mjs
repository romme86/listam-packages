import test from 'node:test'
import assert from 'node:assert/strict'
import {
    DEFAULT_LIST_TYPE,
    TODO_LIST_TYPE,
    NOTES_LIST_TYPE,
    isTodoType,
    isNotesType,
    normalizeListType,
} from './identity.mjs'

test('TODO_LIST_TYPE is the canonical "todo" wire value, distinct from the default', () => {
    assert.equal(TODO_LIST_TYPE, 'todo')
    assert.notEqual(TODO_LIST_TYPE, DEFAULT_LIST_TYPE)
})

test('isTodoType is true only for the exact todo type', () => {
    assert.equal(isTodoType('todo'), true)
    assert.equal(isTodoType(TODO_LIST_TYPE), true)

    assert.equal(isTodoType('shopping'), false)
    assert.equal(isTodoType('kanban'), false)
    assert.equal(isTodoType('board'), false)
    assert.equal(isTodoType(''), false)
    assert.equal(isTodoType(undefined), false)
    assert.equal(isTodoType(null), false)
})

test('normalizeListType keeps an explicit todo value (forward-compat for new types)', () => {
    assert.equal(normalizeListType('todo'), 'todo')
    // Blank/missing still falls back to the grocery default, never todo.
    assert.equal(normalizeListType(''), DEFAULT_LIST_TYPE)
    assert.equal(normalizeListType(undefined), DEFAULT_LIST_TYPE)
})

test('NOTES_LIST_TYPE is the canonical "notes" wire value, distinct from the default and todo', () => {
    assert.equal(NOTES_LIST_TYPE, 'notes')
    assert.notEqual(NOTES_LIST_TYPE, DEFAULT_LIST_TYPE)
    assert.notEqual(NOTES_LIST_TYPE, TODO_LIST_TYPE)
})

test('isNotesType is true only for the exact notes type', () => {
    assert.equal(isNotesType('notes'), true)
    assert.equal(isNotesType(NOTES_LIST_TYPE), true)

    assert.equal(isNotesType('todo'), false)
    assert.equal(isNotesType('shopping'), false)
    assert.equal(isNotesType('kanban'), false)
    assert.equal(isNotesType(''), false)
    assert.equal(isNotesType(undefined), false)
    assert.equal(isNotesType(null), false)
})

test('notes and todo types do not overlap', () => {
    assert.equal(isTodoType(NOTES_LIST_TYPE), false)
    assert.equal(isNotesType(TODO_LIST_TYPE), false)
})

test('normalizeListType round-trips the notes type (forward-compat)', () => {
    assert.equal(normalizeListType('notes'), 'notes')
})
