// A board ticket that fails the rigor gate is dropped by apply, but addItem
// already returned true.
//
// Found while trying to stage an "applied then discarded" reorder for Release
// 2.1. It turned out not to be a reorder problem at all — it happens on every
// peer, in every order, with no concurrency involved:
//
//   1. addItem validates the draft, appends to the writer's core, returns true.
//   2. apply reduces it, sees rigorOn with required fields missing, and
//      `continue`s — no view.append, no pushFromBackend, no message to the UI.
//
// So the client is told the write succeeded, and the row never exists. That is
// the same silent-write-loss family the outbox and the refusal messages were
// built to close, arriving through a different door: not a refused write, but an
// ACCEPTED one that the reducer later declines.
//
// boardConfigState.config is NOT null on a fresh base — bootstrapping seeds the
// full default config, and DEFAULT_BOARD_CONFIG has rigorOn: true. So this is
// the default path for any board add that lacks description, checklist,
// estimated hours and complexity, not an edge case behind a setting.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setBackendFs } from './platform-fs.mjs'
import { createBaseContext } from './base-context.mjs'
import { openSharedBase, closeSharedBase, bootstrapSharedOwner } from './shared-base.mjs'
import { addItem, clearWriteChain } from './item.mjs'
import { validateTicketDraft } from './board.mjs'

// ctx.currentList only ever holds the DEFAULT bucket — applyOperationToList
// re-buckets everything else out — so a board/grocery item's fate has to be read
// from the committed view itself.
async function viewTexts (ctx) {
    const out = []
    const view = ctx.autobase.view
    for (let i = 0; i < view.length; i++) {
        const entry = await view.get(i)
        if (entry && typeof entry.text === 'string') out.push(entry.text)
    }
    return out
}

setBackendFs(fs)

async function base (t) {
    const ctx = createBaseContext({ role: 'shared' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listam-rigor-'))
    await openSharedBase(ctx, { storageDir: dir, joinSwarm: false })
    await bootstrapSharedOwner(ctx)
    t.after(async () => {
        clearWriteChain(ctx)
        await closeSharedBase(ctx)
        fs.rmSync(dir, { recursive: true, force: true })
    })
    return ctx
}

test('a fresh base already enforces rigor — config is seeded, not null', async (t) => {
    const ctx = await base(t)
    assert.equal(ctx.boardConfigState?.config?.rigorOn, true,
        'the rigor gate in apply is live from the first board write')
})

test('addItem refuses a ticket the rigor gate would drop, instead of losing it', async (t) => {
    const ctx = await base(t)

    const accepted = await addItem('Bare ticket', 'board-list', 'kanban', null, ctx)
    await ctx.autobase.update()

    // The write path now REFUSES rather than reporting a success the reducer
    // will quietly undo. Before the write-time gate this returned true and the
    // ticket was absent from the view — a silent loss.
    assert.equal(accepted, false, 'addItem refuses a ticket the rigor gate would drop')
    assert.equal(
        (await viewTexts(ctx)).includes('Bare ticket'),
        false,
        'and it is genuinely not in the committed view',
    )
})

test('a rigor-complete ticket does land, so the gate is the cause', async (t) => {
    // Controls for the obvious alternative explanation: that shared-base board
    // adds simply do not work.
    const ctx = await base(t)
    const complete = {
        description: 'Ship the thing',
        checklist: [{ text: 'do it', done: false }],
        estimatedHours: 2,
        estimatedComplexity: 20,
    }
    assert.equal(validateTicketDraft({ ...complete }, ctx.boardConfigState.config).ok, true)

    assert.equal(await addItem('Good ticket', 'board-list', 'kanban', complete, ctx), true)
    await ctx.autobase.update()
    assert.equal(
        (await viewTexts(ctx)).includes('Good ticket'),
        true,
        'a complete ticket lands, so the bare one was refused BY the rigor gate',
    )
})

test('a non-board list is unaffected', async (t) => {
    const ctx = await base(t)
    assert.equal(await addItem('Milk', 'groceries', 'shopping', null, ctx), true)
    await ctx.autobase.update()
    assert.equal((await viewTexts(ctx)).includes('Milk'), true)
})
