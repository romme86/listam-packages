import test from 'node:test'
import assert from 'node:assert/strict'
import { parseIntent, normalizeTranscript, detectWake } from './voice-intent.mjs'

test('normalizeTranscript folds accents, case, punctuation and whitespace', () => {
    assert.equal(normalizeTranscript('  Añade  PAN! '), 'anade pan')
    assert.equal(normalizeTranscript('Note: buy milk.'), 'note buy milk')
    assert.equal(normalizeTranscript(undefined), '')
})

test('detectWake: true only when a wake phrase leads the transcript', () => {
    assert.equal(detectWake('yo add milk'), true)
    assert.equal(detectWake('YO, add milk'), true)
    assert.equal(detectWake('hey listam take a note'), true)
    assert.equal(detectWake('dai dai dai dai add milk'), true)
    // bare command, no wake word -> not addressed by the wake check
    assert.equal(detectWake('add milk'), false)
    // wake word mid-sentence does not count (must lead)
    assert.equal(detectWake('please yo add milk'), false)
    assert.equal(detectWake(''), false)
    assert.equal(detectWake(undefined), false)
})

test('add_item with explicit list', () => {
    const r = parseIntent('add milk to groceries')
    assert.equal(r.intent, 'add_item')
    assert.equal(r.slots.item, 'milk')
    assert.equal(r.slots.list, 'groceries')
})

test('add_item with multi-word item and list', () => {
    const r = parseIntent('add olive oil to the kitchen list')
    assert.equal(r.intent, 'add_item')
    assert.equal(r.slots.item, 'olive oil')
    assert.equal(r.slots.list, 'the kitchen list')
})

test('add_item without a list falls back to default (list = null)', () => {
    const r = parseIntent('add bread')
    assert.equal(r.intent, 'add_item')
    assert.equal(r.slots.item, 'bread')
    assert.equal(r.slots.list, null)
})

test('remove_item', () => {
    const r = parseIntent('remove milk')
    assert.equal(r.intent, 'remove_item')
    assert.equal(r.slots.item, 'milk')

    assert.equal(parseIntent('delete eggs').intent, 'remove_item')
})

test('note with both markers has high confidence', () => {
    const r = parseIntent('note call the plumber on tuesday end note')
    assert.equal(r.intent, 'note')
    assert.equal(r.slots.text, 'call the plumber on tuesday')
    assert.ok(r.confidence >= 0.9)
})

test('note accepts the "and note" STT mishearing of the end marker', () => {
    const r = parseIntent('note call the plumber and note')
    assert.equal(r.intent, 'note')
    assert.equal(r.slots.text, 'call the plumber')
    assert.ok(r.confidence >= 0.9)
})

test('note without an end marker still parses, lower confidence', () => {
    const r = parseIntent('note buy a birthday gift')
    assert.equal(r.intent, 'note')
    assert.equal(r.slots.text, 'buy a birthday gift')
    assert.ok(r.confidence < 0.9)
})

test('note takes priority over command verbs inside the note body', () => {
    const r = parseIntent('note remember to add milk and remove clutter end note')
    assert.equal(r.intent, 'note')
    assert.equal(r.slots.text, 'remember to add milk and remove clutter')
})

test('leading wake words are stripped before parsing', () => {
    assert.equal(parseIntent('yo add eggs to fridge').slots.item, 'eggs')
    assert.equal(parseIntent('hey listam remove butter').intent, 'remove_item')
    assert.equal(parseIntent('dai dai dai dai add salt').slots.item, 'salt')
})

test('lenient: skips a non-wake filler / STT mishear before the verb', () => {
    // "yup" is a common STT mishearing of the wake word "yo"; the verb is no
    // longer at the start, but the command is still clear.
    const r = parseIntent('yup add milk')
    assert.equal(r.intent, 'add_item')
    assert.equal(r.slots.item, 'milk')
    assert.equal(r.slots.list, null)

    const r2 = parseIntent('um, add bread to pantry')
    assert.equal(r2.intent, 'add_item')
    assert.equal(r2.slots.item, 'bread')
    assert.equal(r2.slots.list, 'pantry')

    assert.equal(parseIntent('so remove butter').intent, 'remove_item')
})

test('lenient pass does not invent commands from verbless chatter', () => {
    assert.equal(parseIntent('the weather is nice today').intent, 'unknown')
    assert.equal(parseIntent('i had a lovely breakfast').intent, 'unknown')
})

test('unknown input returns the unknown intent', () => {
    assert.equal(parseIntent('the weather is nice today').intent, 'unknown')
    assert.equal(parseIntent('').intent, 'unknown')
    assert.equal(parseIntent('   ').intent, 'unknown')
})

test('multilingual: italian add with accent folding', () => {
    const r = parseIntent('aggiungi latte alla spesa', 'it')
    assert.equal(r.intent, 'add_item')
    assert.equal(r.slots.item, 'latte')
    assert.equal(r.slots.list, 'spesa')
})

test('multilingual: spanish add and remove', () => {
    assert.deepEqual(
        { i: parseIntent('añade pan a la panadería', 'es').intent, item: parseIntent('añade pan a la panadería', 'es').slots.item },
        { i: 'add_item', item: 'pan' },
    )
    assert.equal(parseIntent('elimina leche', 'es').intent, 'remove_item')
})

test('unknown locale falls back to english grammar', () => {
    assert.equal(parseIntent('add milk to fridge', 'zz').intent, 'add_item')
})
