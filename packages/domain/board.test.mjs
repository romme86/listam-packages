import test from 'node:test'
import assert from 'node:assert/strict'
import {
    DEFAULT_BOARD_CONFIG,
    TIMELINESS,
    validateTicketDraft,
    computeTimeliness,
    applyStatusTransition,
    computeCongruency,
    evaluateRules,
    normalizeBoardConfig,
    doneStatusesOf,
    BOARD_LIST_TYPE,
    LEGACY_BOARD_LIST_TYPE,
    isBoardType,
    isBoardTicket,
    selectTickets,
    groupByStatus,
    ticketBadges,
    buildStatusChange,
    formatDuration,
    deltaPercent,
    BLOCK_TYPES,
    isBlockType,
    normalizeBlocks,
    createBlock,
    blockToText,
    blockFromText,
} from './board.mjs'

const HOUR = 3600000

function draft (fields = {}) {
    return {
        description: 'Plan the trip',
        checklist: [{ id: 't1', text: 'Book flights', done: false }],
        estimatedHours: 6,
        estimatedComplexity: 45,
        ...fields,
    }
}

// --- validateTicketDraft -----------------------------------------------------

test('validateTicketDraft passes everything when rigor is off', () => {
    const cfg = { ...DEFAULT_BOARD_CONFIG, rigorOn: false }
    assert.deepEqual(validateTicketDraft({}, cfg), { ok: true, missing: [] })
})

test('validateTicketDraft accepts a complete draft when rigor is on', () => {
    const res = validateTicketDraft(draft(), DEFAULT_BOARD_CONFIG)
    assert.equal(res.ok, true)
    assert.deepEqual(res.missing, [])
})

test('validateTicketDraft reports every missing required field', () => {
    const res = validateTicketDraft({ description: '   ', checklist: [], estimatedHours: 0, estimatedComplexity: 0 }, DEFAULT_BOARD_CONFIG)
    assert.equal(res.ok, false)
    assert.deepEqual(res.missing, ['description', 'checklist', 'hours', 'complexity'])
})

test('validateTicketDraft enforces complexity 1..100 and hours > 0', () => {
    assert.deepEqual(validateTicketDraft(draft({ estimatedComplexity: 0 }), DEFAULT_BOARD_CONFIG).missing, ['complexity'])
    assert.deepEqual(validateTicketDraft(draft({ estimatedComplexity: 101 }), DEFAULT_BOARD_CONFIG).missing, ['complexity'])
    assert.deepEqual(validateTicketDraft(draft({ estimatedHours: 0 }), DEFAULT_BOARD_CONFIG).missing, ['hours'])
    assert.deepEqual(validateTicketDraft(draft({ checklist: [{ id: 'x', text: '  ', done: false }] }), DEFAULT_BOARD_CONFIG).missing, ['checklist'])
})

// --- computeTimeliness -------------------------------------------------------

test('computeTimeliness bands at +/-10%', () => {
    assert.equal(computeTimeliness(6, 6), TIMELINESS.ON_TIME)
    assert.equal(computeTimeliness(6.5, 6), TIMELINESS.ON_TIME) // +8.3%
    assert.equal(computeTimeliness(6.7, 6), TIMELINESS.OVERTIME) // +11.6%
    assert.equal(computeTimeliness(5.5, 6), TIMELINESS.ON_TIME) // -8.3%
    assert.equal(computeTimeliness(5.3, 6), TIMELINESS.UNDERTIME) // -11.6%
    assert.equal(computeTimeliness(3, 0), null) // no estimate -> unjudgeable
})

// --- applyStatusTransition ---------------------------------------------------

test('entering in_progress arms the timer without accumulating', () => {
    const next = applyStatusTransition({ status: 'todo', inProgressMs: 0 }, { status: 'in_progress' }, 1000)
    assert.equal(next.inProgressSince, 1000)
    assert.equal(next.inProgressMs, 0)
    assert.equal(next.isDone, false)
})

test('leaving in_progress accumulates the elapsed slice', () => {
    const existing = { status: 'in_progress', inProgressSince: 1000, inProgressMs: 0 }
    const next = applyStatusTransition(existing, { status: 'review' }, 1000 + 2 * HOUR)
    assert.equal(next.inProgressMs, 2 * HOUR)
    assert.equal(next.inProgressSince, null)
})

test('bouncing in and out of in_progress sums the slices', () => {
    let cur = { status: 'todo', inProgressMs: 0 }
    cur = applyStatusTransition(cur, { status: 'in_progress' }, 0) // arm at 0
    cur = applyStatusTransition(cur, { status: 'blocked' }, 1 * HOUR) // +1h
    assert.equal(cur.inProgressMs, 1 * HOUR)
    cur = applyStatusTransition(cur, { status: 'in_progress' }, 3 * HOUR) // re-arm
    cur = applyStatusTransition(cur, { status: 'review' }, 3.5 * HOUR) // +0.5h
    assert.equal(cur.inProgressMs, 1.5 * HOUR)
})

test('backward clock skew clamps the slice to zero', () => {
    const existing = { status: 'in_progress', inProgressSince: 5000, inProgressMs: 7 * HOUR }
    const next = applyStatusTransition(existing, { status: 'todo' }, 4000) // now < since
    assert.equal(next.inProgressMs, 7 * HOUR)
})

test('a single oversized slice is capped', () => {
    const existing = { status: 'in_progress', inProgressSince: 0, inProgressMs: 0 }
    const next = applyStatusTransition(existing, { status: 'done', estimatedHours: 1 }, 10000, { maxSliceMs: 1000 })
    assert.equal(next.inProgressMs, 1000)
})

test('entering done freezes timeliness, completion and author', () => {
    const existing = { status: 'in_progress', inProgressSince: 0, inProgressMs: 0, estimatedHours: 6 }
    const onTime = applyStatusTransition(existing, { status: 'done', estimatedHours: 6 }, 6 * HOUR, { writerKey: 'abc' })
    assert.equal(onTime.isDone, true)
    assert.equal(onTime.timeliness, TIMELINESS.ON_TIME)
    assert.equal(onTime.actualInProgressHours, 6)
    assert.equal(onTime.timeOfCompletion, 6 * HOUR)
    assert.equal(onTime.completedBy, 'abc')

    const over = applyStatusTransition({ status: 'in_progress', inProgressSince: 0, inProgressMs: 0, estimatedHours: 6 }, { status: 'done', estimatedHours: 6 }, 8 * HOUR)
    assert.equal(over.timeliness, TIMELINESS.OVERTIME)

    const under = applyStatusTransition({ status: 'in_progress', inProgressSince: 0, inProgressMs: 0, estimatedHours: 6 }, { status: 'done', estimatedHours: 6 }, 3 * HOUR)
    assert.equal(under.timeliness, TIMELINESS.UNDERTIME)
})

test('reopening a done ticket clears the frozen verdict and re-arms', () => {
    const done = { status: 'done', isDone: true, inProgressMs: 6 * HOUR, timeliness: TIMELINESS.ON_TIME, timeOfCompletion: 99, completedBy: 'abc', actualInProgressHours: 6 }
    const reopened = applyStatusTransition(done, { status: 'in_progress', completedBy: 'abc' }, 10 * HOUR)
    assert.equal(reopened.isDone, false)
    assert.equal(reopened.timeliness, null)
    assert.equal(reopened.timeOfCompletion, 0)
    assert.equal(reopened.actualInProgressHours, 0)
    assert.equal(reopened.completedBy, undefined)
    assert.equal(reopened.inProgressSince, 10 * HOUR)
    // a later re-completion recomputes from the carried accumulator + new slice
    const redone = applyStatusTransition(reopened, { status: 'done', estimatedHours: 6 }, 10 * HOUR + 1 * HOUR)
    assert.equal(redone.actualInProgressHours, 7) // 6h carried + 1h new
    assert.equal(redone.timeliness, TIMELINESS.OVERTIME)
})

// --- computeCongruency -------------------------------------------------------

test('computeCongruency returns nothing for no judged tickets', () => {
    assert.deepEqual(computeCongruency([]), [])
    assert.deepEqual(computeCongruency([{ completedBy: 'u', timeliness: null }]), [])
})

test('computeCongruency: perfect calibration scores high, weighted by volume', () => {
    // 10 tickets, avg complexity 50, off-estimate rate 50% (5 overtime) -> gap 0
    const tickets = []
    for (let i = 0; i < 10; i++) {
        tickets.push({ completedBy: 'u1', estimatedComplexity: 50, timeliness: i < 5 ? TIMELINESS.OVERTIME : TIMELINESS.ON_TIME })
    }
    const [u] = computeCongruency(tickets)
    assert.equal(u.user, 'u1')
    assert.equal(u.count, 10)
    assert.equal(u.avgComplexity, 50)
    assert.equal(u.offEstimateRate, 50)
    assert.equal(u.gap, 0)
    assert.equal(u.score, 83) // round(50 + 50 * 10/15)
    assert.equal(u.tendency, 'underestimates') // 5 over, 0 under
})

test('computeCongruency shrinks small samples toward 50', () => {
    // 1 ticket, complexity 0, off-estimate 0 -> gap 0, raw 100, score = round(50 + 50*1/6) = 58
    const [u] = computeCongruency([{ completedBy: 'u', estimatedComplexity: 0, timeliness: TIMELINESS.ON_TIME }])
    assert.equal(u.score, 58)
})

test('computeCongruency flags overestimators (more undertime than overtime)', () => {
    const tickets = [
        { completedBy: 'u', estimatedComplexity: 80, timeliness: TIMELINESS.UNDERTIME },
        { completedBy: 'u', estimatedComplexity: 80, timeliness: TIMELINESS.UNDERTIME },
        { completedBy: 'u', estimatedComplexity: 80, timeliness: TIMELINESS.ON_TIME },
    ]
    const [u] = computeCongruency(tickets)
    assert.equal(u.tendency, 'overestimates')
    assert.equal(u.under, 2)
    assert.equal(u.over, 0)
})

test('computeCongruency groups by completedBy then createdBy fallback', () => {
    const rows = computeCongruency([
        { completedBy: 'a', estimatedComplexity: 50, timeliness: TIMELINESS.ON_TIME },
        { createdBy: 'b', estimatedComplexity: 50, timeliness: TIMELINESS.OVERTIME },
    ])
    assert.deepEqual(rows.map((r) => r.user).sort(), ['a', 'b'])
})

// --- evaluateRules -----------------------------------------------------------

test('done-gate blocks reaching done with open checklist items', () => {
    const res = evaluateRules(DEFAULT_BOARD_CONFIG, { id: 'k', status: 'done', checklist: [{ id: 'a', done: true }, { id: 'b', done: false }] })
    assert.equal(res.ok, false)
    assert.equal(res.blocked[0].kind, 'done-gate')
})

test('done-gate allows reaching done when checklist is complete', () => {
    const res = evaluateRules(DEFAULT_BOARD_CONFIG, { id: 'k', status: 'done', checklist: [{ id: 'a', done: true }] })
    assert.equal(res.ok, true)
})

test('wip-limit blocks exceeding the column limit', () => {
    const cfg = { ...DEFAULT_BOARD_CONFIG, rules: [{ id: 'wip', kind: 'wip-limit', params: { status: 'in_progress', limit: 2 }, enforce: 'block', enabled: true }] }
    const all = [{ id: 'a', status: 'in_progress' }, { id: 'b', status: 'in_progress' }]
    const res = evaluateRules(cfg, { id: 'c', status: 'in_progress' }, { id: 'c', status: 'todo' }, all)
    assert.equal(res.ok, false)
    assert.equal(res.blocked[0].kind, 'wip-limit')
})

test('required-owner can warn instead of block', () => {
    const cfg = { ...DEFAULT_BOARD_CONFIG, rules: [{ id: 'own', kind: 'required-owner', params: { status: 'in_progress' }, enforce: 'warn', enabled: true }] }
    const res = evaluateRules(cfg, { id: 'k', status: 'in_progress', assignee: '' })
    assert.equal(res.ok, true)
    assert.equal(res.warnings[0].kind, 'required-owner')
})

// --- config helpers ----------------------------------------------------------

test('normalizeBoardConfig fills defaults and keeps overrides', () => {
    const cfg = normalizeBoardConfig({ rigorOn: false })
    assert.equal(cfg.rigorOn, false)
    assert.equal(cfg.states.length, DEFAULT_BOARD_CONFIG.states.length)
    assert.deepEqual(doneStatusesOf(cfg), ['done'])
})

// --- board type dual-read (kanban -> board migration) ------------------------

test('isBoardType accepts both the canonical and legacy wire values', () => {
    assert.equal(BOARD_LIST_TYPE, 'board')
    assert.equal(LEGACY_BOARD_LIST_TYPE, 'kanban')
    assert.equal(isBoardType(BOARD_LIST_TYPE), true)
    assert.equal(isBoardType(LEGACY_BOARD_LIST_TYPE), true)
    assert.equal(isBoardType('shopping'), false)
    assert.equal(isBoardType(undefined), false)
})

test('isBoardTicket recognizes legacy and new board tickets', () => {
    assert.equal(isBoardTicket({ listType: 'kanban' }), true)
    assert.equal(isBoardTicket({ listType: 'board' }), true)
    assert.equal(isBoardTicket({ listType: 'shopping' }), false)
    assert.equal(isBoardTicket(null), false)
})

// --- board presentation helpers (shared with mobile) -------------------------

test('selectTickets keeps only board tickets (legacy + canonical)', () => {
    const items = [
        { id: 'a', listType: 'kanban' },
        { id: 'b', listType: 'board' },
        { id: 'c', listType: 'shopping' },
        { id: 'd' },
    ]
    assert.deepEqual(selectTickets(items).map((t) => t.id), ['a', 'b'])
    assert.deepEqual(selectTickets(null), [])
})

test('groupByStatus buckets tickets by state in config order; unknown → first', () => {
    const items = [
        { id: '1', listType: 'board', status: 'in_progress' },
        { id: '2', listType: 'board', status: 'done' },
        { id: '3', listType: 'board', status: 'nonsense' }, // → first column (todo)
        { id: '4', listType: 'board' },                      // missing → first column
        { id: 'x', listType: 'shopping', status: 'todo' },   // not a ticket
    ]
    const cols = groupByStatus(items, DEFAULT_BOARD_CONFIG)
    assert.deepEqual(cols.map((c) => c.state.id), ['todo', 'in_progress', 'blocked', 'review', 'done'])
    assert.deepEqual(cols[0].tickets.map((t) => t.id), ['3', '4'])
    assert.deepEqual(cols[1].tickets.map((t) => t.id), ['1'])
    assert.deepEqual(cols[4].tickets.map((t) => t.id), ['2'])
})

test('ticketBadges extends a live in-progress timer to now', () => {
    const b = ticketBadges(
        { status: 'in_progress', inProgressMs: 1 * HOUR, inProgressSince: 1000, estimatedHours: 6, assignee: 'fr', checklist: [{ done: true }, { done: false }] },
        1000 + 2 * HOUR,
    )
    assert.equal(b.inProgressMs, 3 * HOUR) // 1h stored + 2h live
    assert.equal(b.running, true)
    assert.equal(b.estimatedHours, 6)
    assert.equal(b.assignee, 'fr')
    assert.equal(b.checklistDone, 1)
    assert.equal(b.checklistTotal, 2)

    const idle = ticketBadges({ status: 'todo', createdBy: 'mk' })
    assert.equal(idle.running, false)
    assert.equal(idle.assignee, 'mk') // falls back to createdBy
})

test('buildStatusChange is a no-op on same status, else bumps status + updatedAt', () => {
    assert.equal(buildStatusChange({ status: 'todo' }, 'todo'), null)
    const next = buildStatusChange({ id: 'k', status: 'todo', text: 'x' }, 'in_progress', 5)
    assert.equal(next.status, 'in_progress')
    assert.equal(next.updatedAt, 5)
    assert.equal(next.text, 'x')
})

test('formatDuration / deltaPercent format compactly', () => {
    assert.equal(formatDuration(0), '0m')
    assert.equal(formatDuration(37 * 60000), '37m')
    assert.equal(formatDuration(4 * HOUR + 12 * 60000), '4h 12m')
    assert.equal(deltaPercent(8, 6), 33)
    assert.equal(deltaPercent(3, 6), -50)
    assert.equal(deltaPercent(5, 0), null)
})

// --- block parse/serialize round-trips ---------------------------------------

test('BLOCK_TYPES covers ten kinds (incl. heading + divider) and isBlockType validates them', () => {
    assert.equal(BLOCK_TYPES.length, 10)
    assert.equal(isBlockType('checklist'), true)
    assert.equal(isBlockType('heading'), true)
    assert.equal(isBlockType('divider'), true)
    assert.equal(isBlockType('bogus'), false)
})

test('createBlock makes a well-shaped empty block; normalizeBlocks drops junk', () => {
    const cl = createBlock('checklist', 'b1')
    assert.equal(cl.type, 'checklist')
    assert.deepEqual(cl.items, [{ text: '', done: false }])
    const heading = createBlock('heading', 'h1')
    assert.deepEqual(heading, { id: 'h1', type: 'heading', text: '', level: 2 })
    assert.deepEqual(createBlock('divider', 'd1'), { id: 'd1', type: 'divider' })
    assert.equal(createBlock('nope', 'b2').type, 'markdown') // unknown → markdown
    assert.deepEqual(
        normalizeBlocks([{ id: 'a', type: 'markdown' }, { type: 'links' }, null, { id: 'b', type: 'bogus' }]).map((b) => b.id),
        ['a'],
    )
    // heading + divider survive normalization (incl. the heading level field).
    const structural = [{ id: 'h', type: 'heading', text: 'Plan', level: 3 }, { id: 'd', type: 'divider' }]
    assert.deepEqual(normalizeBlocks(structural), structural)
})

test('blockToText/blockFromText round-trip each block kind', () => {
    const checklist = { id: 'c', type: 'checklist', items: [{ text: 'Buy flights', done: true }, { text: 'Pack', done: false }] }
    assert.deepEqual(blockFromText('checklist', blockToText(checklist)).items, checklist.items)

    const numbered = { id: 'n', type: 'numberedList', items: [{ text: 'One' }, { text: 'Two' }] }
    assert.deepEqual(blockFromText('numberedList', blockToText(numbered)).items, numbered.items)

    const links = { id: 'l', type: 'links', links: [{ label: 'JR Pass', url: 'https://japanrailpass.net' }] }
    assert.deepEqual(blockFromText('links', blockToText(links)).links, links.links)

    const table = { id: 't', type: 'table', rows: [['City', 'Nights'], ['Tokyo', '5']] }
    assert.deepEqual(blockFromText('table', blockToText(table)).rows, table.rows)

    const md = { id: 'm', type: 'markdown', text: 'Hello **world**' }
    assert.equal(blockFromText('markdown', blockToText(md)).text, 'Hello **world**')
})

test('markdown block with headings round-trips verbatim through blockToText/blockFromText', () => {
    const block = { id: 'b1', type: 'markdown', text: '# Title\nIntro with **bold**, *italic* and `code`.\n## Section\n\n### Sub\nLast line.' }
    assert.equal(blockToText(block), block.text)
    assert.deepEqual(blockFromText('markdown', blockToText(block)), { text: block.text })
    assert.deepEqual(normalizeBlocks([block]), [block])
})
