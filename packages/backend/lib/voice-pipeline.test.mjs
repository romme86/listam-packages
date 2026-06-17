// End-to-end host pipeline: STT -> intent parse -> controller -> backend ops.
// Uses a fixture STT (a canned transcript) and a mock backend, so the whole
// host chain is exercised without whisper.cpp, a model, or a leaf.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseIntent } from '@listam/domain/voice-intent'
import { createStt } from './stt/index.mjs'
import { createVoiceController } from './voice-controller.mjs'

const REGISTRY = [
    { id: 'groc1', listId: '__registry__', listType: 'registry', regKind: 'list', regName: 'Groceries', regType: 'shopping', updatedAt: 1 },
]
const CONTENT = [
    { id: 'i1', listId: 'groc1', listType: 'shopping', text: 'milk' },
    { id: 'i2', listId: 'default', listType: 'shopping', text: 'milk' },
]

// Wire the full host pipeline around a canned transcript.
function pipeline (transcript) {
    const calls = { add: [], del: [] }
    const stt = createStt({ engine: 'fixture', config: { transcribe: async () => ({ text: transcript, locale: 'en' }) } })
    const controller = createVoiceController({
        addItem: async (text, listId, listType) => { calls.add.push({ text, listId, listType }); return true },
        deleteItem: async (item) => { calls.del.push(item.id); return true },
        getAllItems: async () => CONTENT,
        getRegistryItems: async () => REGISTRY,
        notesListId: 'notes1',
    })
    return { calls, run: async (pcm = Buffer.alloc(4)) => {
        const { text, locale } = await stt.transcribe({ pcm, sampleRate: 16000, locale: 'en' })
        return controller.execute(parseIntent(text, locale))
    } }
}

test('utterance "add milk to groceries" -> item added to the groceries list', async () => {
    const { calls, run } = pipeline('add milk to groceries')
    const r = await run()
    assert.equal(r.code, 'added')
    assert.deepEqual(calls.add[0], { text: 'milk', listId: 'groc1', listType: 'shopping' })
})

test('utterance "remove milk" -> removed from every list', async () => {
    const { calls, run } = pipeline('remove milk')
    const r = await run()
    assert.equal(r.code, 'removed')
    assert.deepEqual(calls.del.sort(), ['i1', 'i2'])
})

test('utterance "note buy a gift end note" -> note item in the notes list', async () => {
    const { calls, run } = pipeline('note buy a gift end note')
    const r = await run()
    assert.equal(r.code, 'noteSaved')
    assert.deepEqual(calls.add[0], { text: 'buy a gift', listId: 'notes1', listType: 'notes' })
})

test('unrecognized utterance -> unknownCommand, no writes', async () => {
    const { calls, run } = pipeline('what time is it')
    const r = await run()
    assert.equal(r.code, 'unknownCommand')
    assert.equal(calls.add.length + calls.del.length, 0)
})
