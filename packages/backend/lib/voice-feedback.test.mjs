import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceFeedbackHandler, shouldExecuteIntent, DEFAULT_EXEC_FLOORS } from './voice-feedback.mjs'
import { parseIntent, detectWake } from '@listam/domain/voice-intent'

// Records the LED frames the leaf would receive.
function recordingReply () {
    const leds = []
    let dones = 0
    return { leds, get dones () { return dones }, led: (c) => leds.push(c), done: () => { dones++ } }
}

const sttFor = (text, locale = 'en') => ({
    available: async () => true,
    transcribe: async () => ({ text, locale }),
})
const controllerOk = { execute: async (i) => ({ ok: true, intent: i.intent, code: 'added' }) }
const controllerFail = { execute: async (i) => ({ ok: false, intent: i.intent, code: 'notWritable' }) }
// Records every execute() the gate let through, so a test can assert NOTHING was
// written (the gate fired) vs. the command actually ran.
function recordingController () {
    const executed = []
    return { executed, execute: async (i) => { executed.push(i); return { ok: true, intent: i.intent, code: 'added' } } }
}

// No dwells so tests run instantly; real handler dwells to keep colors visible.
const handlerFor = (stt, controller = controllerOk, opts = {}) => createVoiceFeedbackHandler({
    stt, controller, parseIntent, detectWake, locale: 'en', dwellMs: { command: 0, hold: 0, fail: 0 }, ...opts,
})

test('wake + command + save -> yellow, purple, green', async () => {
    const reply = recordingReply()
    await handlerFor(sttFor('yo add milk'))({ pcm: Buffer.alloc(0) }, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
    assert.equal(reply.dones, 1)
})

test('anchored "add milk" without a wake word clears the floor (0.75) -> executes', async () => {
    // Hands-free add still works: the anchored grammar yields 0.75, == the add
    // floor, so it executes and saves even with no wake word.
    const reply = recordingReply()
    await handlerFor(sttFor('add milk'))({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
    assert.equal(reply.dones, 1)
})

test('wake word only (no command) -> yellow then red (heard but not understood)', async () => {
    const reply = recordingReply()
    await handlerFor(sttFor('yo'))({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'red'])
    assert.equal(reply.dones, 1)
})

test('ambient speech (no wake, no command) -> dark, just done', async () => {
    const reply = recordingReply()
    await handlerFor(sttFor('what a lovely day'))({}, reply)
    assert.deepEqual(reply.leds, [])
    assert.equal(reply.dones, 1)
})

test('command recognized but save fails -> yellow, purple, red', async () => {
    const reply = recordingReply()
    await handlerFor(sttFor('yo add milk'), controllerFail)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'red'])
    assert.equal(reply.dones, 1)
})

test('STT unavailable -> dark, just done', async () => {
    const reply = recordingReply()
    const stt = { available: async () => false, transcribe: async () => { throw new Error('should not be called') } }
    await handlerFor(stt)({}, reply)
    assert.deepEqual(reply.leds, [])
    assert.equal(reply.dones, 1)
})

test('STT throws -> red, and done still fires exactly once', async () => {
    const reply = recordingReply()
    const stt = { available: async () => true, transcribe: async () => { throw new Error('whisper crashed') } }
    await handlerFor(stt)({}, reply)
    assert.deepEqual(reply.leds, ['red'])
    assert.equal(reply.dones, 1)
})

test('every path calls done exactly once (no hang, no double-done)', async () => {
    for (const text of ['yo add milk', 'add milk', 'yo', 'random noise', '']) {
        const reply = recordingReply()
        await handlerFor(sttFor(text))({}, reply)
        assert.equal(reply.dones, 1, `done==1 for "${text}"`)
    }
})

test('constructor rejects missing collaborators', () => {
    assert.throws(() => createVoiceFeedbackHandler({ stt: {}, controller: {} }))
})

// ---- write gate: ambient speech that parses must NOT execute/save -------------

test('ambient "please put the kettle on" parses to add 0.6 but is gated -> no save, no green', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('please put the kettle on'), ctl)({}, reply)
    // The parse still lights up (yellow=heard, purple=command) so on-device
    // debugging shows it was understood, but it stops before green and never runs.
    assert.deepEqual(reply.leds, ['yellow', 'purple'])
    assert.equal(ctl.executed.length, 0, 'gated add must not execute')
    assert.equal(reply.dones, 1)
})

test('ambient "take off your shoes" parses to remove 0.85 but is gated -> nothing deleted', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('take off your shoes'), ctl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple'])
    assert.equal(ctl.executed.length, 0, 'destructive remove must not run on ambient speech')
    assert.equal(reply.dones, 1)
})

test('bare "remove milk" without a wake word is gated (remove floor exceeds the grammar max)', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('remove milk'), ctl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple'])
    assert.equal(ctl.executed.length, 0, 'a wake word is required to delete')
})

test('a clean wake word bypasses the floor — "yo um add milk" (lenient 0.6) executes', async () => {
    // The lenient retry exists to recover a mis-heard wake ("yup add milk"); when a
    // real wake word IS present, even a 0.6 parse should run.
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('yo um add milk'), ctl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
    assert.equal(ctl.executed.length, 1)
    assert.equal(ctl.executed[0].intent, 'add_item')
})

test('a clean wake word executes a destructive remove — "yo remove milk"', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('yo remove milk'), ctl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
    assert.equal(ctl.executed.length, 1)
    assert.equal(ctl.executed[0].intent, 'remove_item')
})

test('a full note (0.95, both markers) clears the note floor without a wake word', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('note buy a gift end note'), ctl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
    assert.equal(ctl.executed.length, 1)
    assert.equal(ctl.executed[0].intent, 'note')
})

test('floors are configurable — loosening the add floor lets a 0.6 parse through', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('please put the kettle on'), ctl, { execFloors: { add_item: 0.5 } })({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
    assert.equal(ctl.executed.length, 1, 'a lower floor admits the lenient add')
})

test('gated path still calls done exactly once', async () => {
    for (const text of ['please put the kettle on', 'take off your shoes', 'remove milk']) {
        const reply = recordingReply()
        await handlerFor(sttFor(text), recordingController())({}, reply)
        assert.equal(reply.dones, 1, `done==1 for gated "${text}"`)
    }
})

// ---- shouldExecuteIntent (pure policy) ----------------------------------------

test('shouldExecuteIntent: wake bypasses the floor, unknown never runs', () => {
    assert.equal(shouldExecuteIntent({ intent: 'unknown', confidence: 1 }, { wake: true }), false)
    assert.equal(shouldExecuteIntent({ intent: 'add_item', confidence: 0 }, { wake: true }), true)
    assert.equal(shouldExecuteIntent(null, { wake: true }), false)
})

test('shouldExecuteIntent: without wake, per-intent floors apply (remove stricter than add)', () => {
    assert.equal(shouldExecuteIntent({ intent: 'add_item', confidence: 0.75 }, {}), true)
    assert.equal(shouldExecuteIntent({ intent: 'add_item', confidence: 0.6 }, {}), false)
    // 0.85 is the grammar's max for an anchored remove — still below the 0.9 floor.
    assert.equal(shouldExecuteIntent({ intent: 'remove_item', confidence: 0.85 }, {}), false)
    assert.equal(shouldExecuteIntent({ intent: 'note', confidence: 0.7 }, {}), false)
    assert.equal(shouldExecuteIntent({ intent: 'note', confidence: 0.95 }, {}), true)
})

test('shouldExecuteIntent: defaults match DEFAULT_EXEC_FLOORS and remove is the strictest', () => {
    assert.equal(DEFAULT_EXEC_FLOORS.add_item, 0.75)
    assert.equal(DEFAULT_EXEC_FLOORS.note, 0.75)
    assert.ok(DEFAULT_EXEC_FLOORS.remove_item > 0.85, 'remove floor must exceed the grammar max so ambient removes are blocked')
})
