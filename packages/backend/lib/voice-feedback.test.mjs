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
    await handlerFor(sttFor('yo petito add milk'))({ pcm: Buffer.alloc(0) }, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
    assert.equal(reply.dones, 1)
})

test('direct petito command authorizes the fast capture path', async () => {
    const reply = recordingReply()
    const ctrl = recordingController()
    await handlerFor(sttFor('petito add milk'), ctrl)({ wake: { fired: false, prob: 0.02 } }, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
    assert.equal(ctrl.executed.length, 1)
})

test('anchored "add milk" without the full wake phrase is gated', async () => {
    const reply = recordingReply()
    const ctrl = recordingController()
    await handlerFor(sttFor('add milk'), ctrl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'red'])
    assert.equal(ctrl.executed.length, 0)
    assert.equal(reply.dones, 1)
})

test('wake word only (no command) -> yellow then red (heard but not understood)', async () => {
    const reply = recordingReply()
    await handlerFor(sttFor('yo petito'))({}, reply)
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
    await handlerFor(sttFor('yo petito add milk'), controllerFail)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'red'])
    assert.equal(reply.dones, 1)
})

test('on-device yo alone opens capture but cannot authorize a mutation', async () => {
    const ctrl = recordingController()
    const reply = recordingReply()
    await handlerFor(sttFor('io aggiungi latte', 'it'), ctrl)({ wake: { fired: true, prob: 0.996 } }, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'red'])
    assert.equal(ctrl.executed.length, 0)
})

test('full "io petito" transcript authorizes when Whisper mishears yo', async () => {
    const ctrl = recordingController()
    const reply = recordingReply()
    await handlerFor(sttFor('io petito aggiungi latte', 'it'), ctrl)({}, reply)
    assert.equal(ctrl.executed.length, 1)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
})

test('WITHOUT on-device wake, a wake-less mishear ("e …") stays gated', async () => {
    // 'e' is NOT a wake alias (ambient noise transcribes as "e"): no wake +
    // lenient 0.6 < the 0.75 add floor -> gated, red verdict, nothing written.
    const ctrl = recordingController()
    const reply = recordingReply()
    await handlerFor(sttFor('e aggiungi latte', 'it'), ctrl)({}, reply)
    assert.equal(ctrl.executed.length, 0)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'red'])
})

test('STT unavailable -> dark, just done', async () => {
    const reply = recordingReply()
    const stt = { available: async () => false, transcribe: async () => { throw new Error('should not be called') } }
    await handlerFor(stt)({}, reply)
    assert.deepEqual(reply.leds, [])
    assert.equal(reply.dones, 1)
})

test('STT throws on an unaddressed capture -> dark, done exactly once', async () => {
    // No firmware wake fired, so nothing was lit pre-STT: a whisper crash on
    // what is probably ambient noise must not blink red at the room.
    const reply = recordingReply()
    const stt = { available: async () => true, transcribe: async () => { throw new Error('whisper crashed') } }
    await handlerFor(stt)({}, reply)
    assert.deepEqual(reply.leds, [])
    assert.equal(reply.dones, 1)
})

test('STT throws after an on-device wake -> yellow then red, done exactly once', async () => {
    const reply = recordingReply()
    const stt = { available: async () => true, transcribe: async () => { throw new Error('whisper crashed') } }
    await handlerFor(stt)({ wake: { fired: true, prob: 0.99 } }, reply)
    assert.deepEqual(reply.leds, ['yellow', 'red'])
    assert.equal(reply.dones, 1)
})

test('STT slower than the budget -> red while the leaf still listens, done once', async () => {
    const reply = recordingReply()
    const stt = { available: async () => true, transcribe: () => new Promise(() => {}) } // never settles
    const handler = createVoiceFeedbackHandler({
        stt, controller: controllerOk, parseIntent, detectWake, locale: 'en',
        dwellMs: { command: 0, hold: 0, fail: 0 }, sttTimeoutMs: 20,
    })
    await handler({ wake: { fired: true, prob: 0.99 } }, reply)
    assert.deepEqual(reply.leds, ['yellow', 'red'])
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
    // The parse still lights up (yellow=heard, purple=command) and the gate now
    // closes with an explicit red — "understood but not saved" — instead of
    // going dark (which read as a hang). It stops before green and never runs.
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'red'])
    assert.equal(ctl.executed.length, 0, 'gated add must not execute')
    assert.equal(reply.dones, 1)
})

test('ambient "take off your shoes" parses to remove 0.85 but is gated -> nothing deleted', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('take off your shoes'), ctl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'red'])
    assert.equal(ctl.executed.length, 0, 'destructive remove must not run on ambient speech')
    assert.equal(reply.dones, 1)
})

test('bare "remove milk" without a wake word is gated (remove floor exceeds the grammar max)', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('remove milk'), ctl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'red'])
    assert.equal(ctl.executed.length, 0, 'a wake word is required to delete')
})

test('a full wake phrase bypasses the floor for a lenient parse', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('yo petito um add milk'), ctl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
    assert.equal(ctl.executed.length, 1)
    assert.equal(ctl.executed[0].intent, 'add_item')
})

test('a full wake phrase executes a destructive remove', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('yo petito remove milk'), ctl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'green'])
    assert.equal(ctl.executed.length, 1)
    assert.equal(ctl.executed[0].intent, 'remove_item')
})

test('a full note without the wake phrase is still gated', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('note buy a gift end note'), ctl)({}, reply)
    assert.deepEqual(reply.leds, ['yellow', 'purple', 'red'])
    assert.equal(ctl.executed.length, 0)
})

test('legacy wake-optional mode can still use configurable floors', async () => {
    const reply = recordingReply()
    const ctl = recordingController()
    await handlerFor(sttFor('please put the kettle on'), ctl, {
        execFloors: { add_item: 0.5 },
        requireWakePhrase: false,
    })({}, reply)
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

test('shouldExecuteIntent: wake-optional mode retains per-intent floors', () => {
    const legacy = { requireWakePhrase: false }
    assert.equal(shouldExecuteIntent({ intent: 'add_item', confidence: 0.75 }, {}), false)
    assert.equal(shouldExecuteIntent({ intent: 'add_item', confidence: 0.75 }, legacy), true)
    assert.equal(shouldExecuteIntent({ intent: 'add_item', confidence: 0.6 }, legacy), false)
    // 0.85 is the grammar's max for an anchored remove — still below the 0.9 floor.
    assert.equal(shouldExecuteIntent({ intent: 'remove_item', confidence: 0.85 }, legacy), false)
    assert.equal(shouldExecuteIntent({ intent: 'note', confidence: 0.7 }, legacy), false)
    assert.equal(shouldExecuteIntent({ intent: 'note', confidence: 0.95 }, legacy), true)
})

test('shouldExecuteIntent: defaults match DEFAULT_EXEC_FLOORS and remove is the strictest', () => {
    assert.equal(DEFAULT_EXEC_FLOORS.add_item, 0.75)
    assert.equal(DEFAULT_EXEC_FLOORS.note, 0.75)
    assert.ok(DEFAULT_EXEC_FLOORS.remove_item > 0.85, 'remove floor must exceed the grammar max so ambient removes are blocked')
})
