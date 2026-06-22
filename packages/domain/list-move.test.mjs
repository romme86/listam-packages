import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMovedItem, isSameSurfaceMove, MOVE_TICKET_FIELDS } from './list-move.mjs'
import { BOARD_WRITE_TYPE, isBoardType } from './board.mjs'
import { TODO_LIST_TYPE } from './identity.mjs'

const NOW = 1_700_000_000_000

const grocery = (over = {}) => ({
    id: 'item-1', listId: 'default', listType: 'shopping',
    text: 'milk', isDone: false, timeOfCompletion: 0, updatedAt: 1, ...over,
})

const ticket = (over = {}) => ({
    id: 'tk-1', listId: 'board-a', listType: 'kanban',
    text: 'Ship it', isDone: false, timeOfCompletion: 0, updatedAt: 1,
    status: 'in_progress', inProgressMs: 5000, inProgressSince: 999,
    actualInProgressHours: 2, timeliness: 'on_time', completedBy: 'peerX',
    createdBy: 'peerY', priority: 'high', description: 'do the thing',
    checklist: [{ id: 'c1', text: 'a', done: true }],
    estimatedHours: 3, estimatedComplexity: 40,
    blocks: [{ id: 'b1', type: 'markdown', markdown: 'hi' }],
    ...over,
})

test('isSameSurfaceMove keys on listId only (built-ins share "default")', () => {
    assert.equal(isSameSurfaceMove(grocery(), 'default'), true)     // Groceries -> Todo, both default
    assert.equal(isSameSurfaceMove(grocery(), 'list-123'), false)   // -> a named list
    assert.equal(isSameSurfaceMove(ticket(), 'board-a'), true)
    assert.equal(isSameSurfaceMove(ticket(), 'board-b'), false)
})

test('every move preserves id + base fields and bumps updatedAt', () => {
    const dest = buildMovedItem(grocery(), 'list-9', 'shopping', { now: NOW })
    assert.equal(dest.id, 'item-1')           // id preserved -> idempotent under LWW
    assert.equal(dest.text, 'milk')
    assert.equal(dest.isDone, false)
    assert.equal(dest.timeOfCompletion, 0)
    assert.equal(dest.listId, 'list-9')
    assert.equal(dest.updatedAt, NOW)         // bumped so dest write wins
})

test('grocery -> todo: trivial, base fields only, no board stamping', () => {
    const dest = buildMovedItem(grocery(), 'list-9', TODO_LIST_TYPE, { now: NOW })
    assert.equal(dest.listType, TODO_LIST_TYPE)
    assert.equal(isBoardType(dest.listType), false)
    assert.equal(dest.status, undefined)
    assert.equal(dest.createdBy, undefined)
})

test('a moved item drops any manual order so it floats to the destination top', () => {
    const dest = buildMovedItem(grocery({ order: 5000 }), 'list-9', 'shopping', { now: NOW })
    assert.equal('order' in dest, false)
})

test('grocery -> board (promote): wire type, fresh server fields, merged form fields', () => {
    const dest = buildMovedItem(grocery(), 'board-b', 'board', {
        now: NOW, writerKey: 'me',
        fields: { description: 'd', checklist: [{ id: 'c', text: 't', done: false }], estimatedHours: 2, estimatedComplexity: 30 },
    })
    assert.equal(dest.listType, BOARD_WRITE_TYPE)   // 'kanban' wire type, never 'board'
    assert.equal(dest.status, 'todo')
    assert.equal(dest.inProgressMs, 0)
    assert.equal(dest.inProgressSince, null)
    assert.equal(dest.createdBy, 'me')
    assert.equal(dest.isDone, false)
    assert.equal(dest.description, 'd')
    assert.equal(dest.estimatedComplexity, 30)
    // never carries forged frozen fields
    assert.equal(dest.completedBy, undefined)
    assert.equal(dest.timeliness, undefined)
    assert.equal(dest.actualInProgressHours, undefined)
})

test('promote honors an explicit done status (isDone follows status)', () => {
    const dest = buildMovedItem(grocery(), 'board-b', 'board', { now: NOW, fields: { status: 'done' } })
    assert.equal(dest.status, 'done')
    assert.equal(dest.isDone, true)
})

test('board -> grocery (demote): board fields ride along dormant for reversibility', () => {
    const dest = buildMovedItem(ticket(), 'list-9', 'shopping', { now: NOW })
    assert.equal(isBoardType(dest.listType), false)
    // dormant board content kept so a move back restores the ticket
    assert.equal(dest.description, 'do the thing')
    assert.equal(dest.priority, 'high')
    assert.deepEqual(dest.blocks, [{ id: 'b1', type: 'markdown', markdown: 'hi' }])
    assert.equal(dest.status, 'in_progress')
    // base fields intact
    assert.equal(dest.id, 'tk-1')
    assert.equal(dest.text, 'Ship it')
})

test('board -> board (instance move): all board fields incl. frozen tracking preserved', () => {
    const dest = buildMovedItem(ticket(), 'board-b', 'board', { now: NOW, writerKey: 'me' })
    assert.equal(dest.listId, 'board-b')
    assert.equal(dest.listType, BOARD_WRITE_TYPE)
    assert.equal(dest.status, 'in_progress')
    assert.equal(dest.inProgressMs, 5000)
    assert.equal(dest.inProgressSince, 999)
    assert.equal(dest.actualInProgressHours, 2)
    assert.equal(dest.timeliness, 'on_time')
    assert.equal(dest.completedBy, 'peerX')
    assert.equal(dest.createdBy, 'peerY')   // NOT overwritten on a board->board move
})

test('re-promoting a demoted ticket restores content but resets the workflow', () => {
    // ticket -> grocery (dormant) -> board again
    const demoted = buildMovedItem(ticket(), 'list-9', 'shopping', { now: NOW })
    const repromoted = buildMovedItem(demoted, 'board-c', 'board', { now: NOW + 1, writerKey: 'me' })
    assert.equal(repromoted.description, 'do the thing')   // content restored
    assert.equal(repromoted.priority, 'high')
    assert.equal(repromoted.status, 'todo')                // workflow reset
    assert.equal(repromoted.inProgressMs, 0)
    assert.equal(repromoted.inProgressSince, null)
    assert.equal(repromoted.completedBy, undefined)        // stale frozen fields cleared
    assert.equal(repromoted.timeliness, undefined)
    assert.equal(repromoted.actualInProgressHours, undefined)
    assert.equal(repromoted.createdBy, 'me')
})

test('MOVE_TICKET_FIELDS excludes server-frozen fields', () => {
    for (const forbidden of ['createdBy', 'completedBy', 'timeliness', 'inProgressSince', 'actualInProgressHours', 'inProgressMs']) {
        assert.equal(MOVE_TICKET_FIELDS.includes(forbidden), false, `${forbidden} must not be client-settable`)
    }
})
