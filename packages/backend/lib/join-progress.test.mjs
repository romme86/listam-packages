import test from 'node:test'
import assert from 'node:assert/strict'

import { createJoinProgressDeadline } from './join-progress.mjs'

const TIMEOUT = 120_000

test('a join replaying history for far longer than the timeout never expires', () => {
    // The regression this exists for: a guest joining a base with a long
    // history took ~5 minutes to reach writability while the view advanced
    // steadily the whole time. Under a fixed wall-clock cap the watch reported
    // "timed out waiting for write access" at 120s and the join then succeeded
    // minutes later, with the UI already showing an error.
    const t0 = 1_000_000
    const progress = createJoinProgressDeadline({ timeoutMs: TIMEOUT, now: t0 })

    let view = 0
    for (let elapsed = 5_000; elapsed <= 300_000; elapsed += 5_000) {
        const at = t0 + elapsed
        assert.equal(progress.expired(at), false, `expired while still replaying at ${elapsed}ms`)
        progress.observeViewLength((view += 40), at)
    }
})

test('a guest that stops linearizing expires one timeout after the last advance', () => {
    const t0 = 1_000_000
    const progress = createJoinProgressDeadline({ timeoutMs: TIMEOUT, now: t0 })

    progress.observeViewLength(500, t0 + 10_000)
    assert.equal(progress.deadlineAt(), t0 + 10_000 + TIMEOUT)

    assert.equal(progress.expired(t0 + 10_000 + TIMEOUT - 1), false)
    assert.equal(progress.expired(t0 + 10_000 + TIMEOUT), true)
})

test('a view that is not advancing is not progress', () => {
    // Autobase emits 'update' and the fallback poll fires regardless of whether
    // anything linearized. Re-reading the same length must not hold the watch
    // open forever on a wedged guest.
    const t0 = 1_000_000
    const progress = createJoinProgressDeadline({ timeoutMs: TIMEOUT, now: t0 })

    assert.equal(progress.observeViewLength(120, t0 + 1_000), true)
    assert.equal(progress.observeViewLength(120, t0 + 60_000), false)
    assert.equal(progress.observeViewLength(120, t0 + 119_000), false)
    assert.equal(progress.expired(t0 + 1_000 + TIMEOUT), true)
})

test('a view that shrinks on a reorg does not count as progress', () => {
    // Autobase truncates the linearized view when the indexer set changes, so
    // the length can go backwards. Only a new high-water mark is progress.
    const t0 = 1_000_000
    const progress = createJoinProgressDeadline({ timeoutMs: TIMEOUT, now: t0 })

    progress.observeViewLength(900, t0)
    assert.equal(progress.observeViewLength(400, t0 + 30_000), false)
    assert.equal(progress.observeViewLength(899, t0 + 60_000), false)
    assert.equal(progress.observeViewLength(901, t0 + 90_000), true)
})

test('a non-numeric view length is ignored rather than treated as progress', () => {
    const t0 = 1_000_000
    const progress = createJoinProgressDeadline({ timeoutMs: TIMEOUT, now: t0 })

    assert.equal(progress.observeViewLength(undefined, t0 + 1_000), false)
    assert.equal(progress.observeViewLength(NaN, t0 + 2_000), false)
    assert.equal(progress.deadlineAt(), t0 + TIMEOUT)
})

test('noteProgress extends the deadline for progress the view length cannot show', () => {
    // Writability flipping is progress even when nothing new linearized.
    const t0 = 1_000_000
    const progress = createJoinProgressDeadline({ timeoutMs: TIMEOUT, now: t0 })

    progress.noteProgress(t0 + 100_000)
    assert.equal(progress.expired(t0 + 150_000), false)
    assert.equal(progress.expired(t0 + 100_000 + TIMEOUT), true)
})

test('a positive timeout is required', () => {
    assert.throws(() => createJoinProgressDeadline({ timeoutMs: 0 }), /positive timeoutMs/)
    assert.throws(() => createJoinProgressDeadline({}), /positive timeoutMs/)
})
